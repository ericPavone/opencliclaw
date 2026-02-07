import type { PluginLogger } from "openclaw/plugin-sdk";
import type {
  RoutingContextDoc,
  ClassificationConfig,
  RoutingRule,
} from "./collections/routing.js";
import { getModelByTierWithEscalation } from "./collections/routing.js";

// ==========================================================================
// Prompt Classification
// ==========================================================================

export type ClassificationResult = {
  category: string;
  complexity: number;
  matchedIndicators: string[];
};

export function classifyPrompt(
  prompt: string,
  classification: ClassificationConfig,
): ClassificationResult {
  const lower = prompt.toLowerCase();
  const matchedIndicators: string[] = [];
  const categoryScores: Record<string, number> = {};

  for (const [category, indicators] of Object.entries(classification.indicators)) {
    let score = 0;
    for (const ind of indicators) {
      if (lower.includes(ind.toLowerCase())) {
        score++;
        matchedIndicators.push(`${category}:${ind}`);
      }
    }
    if (score > 0) categoryScores[category] = score;
  }

  // Path patterns boost CODE/TOOL
  const hasPathRef = classification.path_patterns.some((p) => prompt.includes(p));
  if (hasPathRef) {
    categoryScores.CODE = (categoryScores.CODE ?? 0) + 1;
  }

  // Code block detection boosts CODE
  const codeBlockRe = new RegExp(classification.code_block_regex);
  if (codeBlockRe.test(prompt)) {
    categoryScores.CODE = (categoryScores.CODE ?? 0) + 2;
  }

  // Pick the category with highest score, or "CHAT" if no indicators matched
  let bestCategory = "CHAT";
  let bestScore = 0;
  for (const [cat, score] of Object.entries(categoryScores)) {
    if (score > bestScore) {
      bestScore = score;
      bestCategory = cat;
    }
  }

  // Compute complexity from the category's range
  const catDef = classification.categories[bestCategory];
  const [lo, hi] = catDef?.complexity_range ?? [1, 3];
  const complexity = Math.min(hi, lo + bestScore);

  return { category: bestCategory, complexity, matchedIndicators };
}

// ==========================================================================
// Routing Decision
// ==========================================================================

export type RoutingDecision =
  | {
      override: true;
      provider: string;
      model: string;
      reason: string;
      category: string;
      complexity: number;
      tier: string;
    }
  | {
      override: false;
      reason: string;
      category: string;
      complexity: number;
    };

export function resolveRoutingOverride(
  prompt: string,
  routingDoc: RoutingContextDoc,
  toolsInContext: boolean,
  logger?: PluginLogger,
  agentId?: string,
  isModelHealthy?: (modelId: string) => boolean,
): RoutingDecision {
  const tag = agentId ? `agent=${agentId}` : "agent=default";

  // 1. Classify prompt
  const { category, complexity, matchedIndicators } = classifyPrompt(
    prompt,
    routingDoc.classification,
  );

  // 2. Find matching routing rule (highest priority wins)
  const matchingRules = routingDoc.routing.rules.filter(
    (r) => r.if === category && r.tools_in_context === toolsInContext,
  );
  matchingRules.sort((a, b) => b.priority - a.priority);

  const matchedRule: RoutingRule | undefined = matchingRules[0];

  if (!matchedRule) {
    // No rule matched — check ambiguous_action
    if (routingDoc.routing.ambiguous_action === "use_default") {
      const tier = routingDoc.routing.default_tier;
      const escalated = getModelByTierWithEscalation(
        routingDoc,
        tier,
        toolsInContext,
        isModelHealthy,
      );
      if (escalated) {
        const reason = `no_rule_match, using default_tier=${tier}${escalated.tier !== tier ? ` (escalated→${escalated.tier})` : ""}`;
        logger?.info?.(
          `routing: ${tag} category=${category} complexity=${complexity} tier=${escalated.tier} model=${escalated.model.id} reason="${reason}"`,
        );
        return {
          override: true,
          provider: escalated.model.id.split("/")[0],
          model: escalated.model.id.split("/").slice(1).join("/"),
          reason,
          category,
          complexity,
          tier: escalated.tier,
        };
      }
    }

    const reason = `no_rule_match category=${category} tools=${toolsInContext} indicators=[${matchedIndicators.join(",")}]`;
    logger?.info?.(`routing: ${tag} no_override reason="${reason}"`);
    return { override: false, reason, category, complexity };
  }

  const tier = matchedRule.then;

  // 3. Select model with escalation (handles capability check + health)
  const escalated = getModelByTierWithEscalation(routingDoc, tier, toolsInContext, isModelHealthy);
  if (!escalated) {
    const reason = `all_tiers_exhausted starting_tier=${tier} tools=${toolsInContext}`;
    logger?.info?.(`routing: ${tag} no_override reason="${reason}"`);
    return { override: false, reason, category, complexity };
  }

  const reason = matchedRule.reason
    ? `${matchedRule.reason}${escalated.tier !== tier ? ` (escalated ${tier}→${escalated.tier})` : ""}`
    : `rule: ${category}+tools=${toolsInContext}→${escalated.tier}`;

  logger?.info?.(
    `routing: ${tag} category=${category} complexity=${complexity} tier=${escalated.tier} model=${escalated.model.id} reason="${reason}"`,
  );

  return {
    override: true,
    provider: escalated.model.id.split("/")[0],
    model: escalated.model.id.split("/").slice(1).join("/"),
    reason,
    category,
    complexity,
    tier: escalated.tier,
  };
}
