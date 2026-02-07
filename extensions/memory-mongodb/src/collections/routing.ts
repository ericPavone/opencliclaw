import type { Collection } from "mongodb";
import type { OpenClawConfig } from "openclaw/plugin-sdk";

// ==========================================================================
// Types
// ==========================================================================

export type RoutingModel = {
  id: string;
  alias: string;
  tier: "fast" | "mid" | "heavy";
  capabilities: {
    tools: boolean;
    filesystem: boolean;
    code_execution: boolean;
    reasoning: "light" | "standard" | "deep";
    [key: string]: unknown;
  };
  use_when: string[];
  never_when: string[];
  active?: boolean;
};

export type TierHeuristic = {
  match: string[];
  indicators: string[];
  default_capabilities: {
    tools: boolean;
    filesystem: boolean;
    code_execution: boolean;
    reasoning: "light" | "standard" | "deep";
  };
};

export type ModelDiscovery = {
  tier_heuristics: Record<string, TierHeuristic>;
  cli_provider_rule: string;
  unknown_model_rule: string;
  user_override: string;
};

export type ClassificationCategory = {
  complexity_range: [number, number];
  description: string;
};

export type ClassificationConfig = {
  categories: Record<string, ClassificationCategory>;
  indicators: Record<string, string[]>;
  path_patterns: string[];
  code_block_regex: string;
};

export type RoutingRule = {
  if: string;
  tools_in_context: boolean;
  then: string;
  priority: number;
  reason?: string;
};

export type RoutingRules = {
  default_tier: string;
  ambiguous_action: "no_override" | "use_default";
  capability_constraint: string;
  rules: RoutingRule[];
};

export type EscalationConfig = {
  triggers: string[];
  de_escalation_triggers: string[];
};

export type RoutingContextDoc = {
  _id?: unknown;
  agent_id: string;
  version: number;
  models: RoutingModel[];
  models_hash?: string;
  model_discovery?: ModelDiscovery;
  classification: ClassificationConfig;
  routing: RoutingRules;
  escalation: EscalationConfig;
  created_at: Date;
  updated_at: Date;
};

// ==========================================================================
// CRUD
// ==========================================================================

export async function getRoutingContext(
  col: Collection,
  agentId?: string,
): Promise<RoutingContextDoc | null> {
  const doc = await col.findOne({ agent_id: agentId ?? "default" });
  return doc as unknown as RoutingContextDoc | null;
}

export async function storeRoutingContext(
  col: Collection,
  doc: Omit<RoutingContextDoc, "_id" | "created_at" | "updated_at">,
): Promise<{ action: "created" | "updated" }> {
  const now = new Date();
  const filter = { agent_id: doc.agent_id };
  const { _id, created_at, updated_at, ...clean } = doc as Record<string, unknown>;
  const result = await col.updateOne(
    filter,
    {
      $set: { ...clean, updated_at: now },
      $setOnInsert: { created_at: now },
    },
    { upsert: true },
  );
  return { action: result.upsertedId ? "created" : "updated" };
}

export function getModelByTier(doc: RoutingContextDoc, tier: string): RoutingModel | null {
  const eligible = doc.models.filter((m) => m.tier === tier && m.active !== false);
  return eligible[0] ?? null;
}

const TIER_ESCALATION: Record<string, string[]> = {
  fast: ["fast", "mid", "heavy"],
  mid: ["mid", "heavy"],
  heavy: ["heavy"],
};

export type EscalationResult = { model: RoutingModel; tier: string } | null;

export function getModelByTierWithEscalation(
  doc: RoutingContextDoc,
  startTier: string,
  requireTools: boolean,
  isModelHealthy?: (modelId: string) => boolean,
): EscalationResult {
  const chain = TIER_ESCALATION[startTier] ?? [startTier];
  for (const tier of chain) {
    const candidates = doc.models.filter((m) => {
      if (m.tier !== tier || m.active === false) return false;
      if (requireTools && !m.capabilities.tools) return false;
      if (isModelHealthy && !isModelHealthy(m.id)) return false;
      return true;
    });
    if (candidates.length > 0) return { model: candidates[0], tier };
  }
  return null;
}

// ==========================================================================
// In-Memory Cache
// ==========================================================================

type CacheEntry = { doc: RoutingContextDoc; loadedAt: number };

export class RoutingCache {
  private cache = new Map<string, CacheEntry>();
  private ttlMs: number;

  constructor(ttlMs = 60_000) {
    this.ttlMs = ttlMs;
  }

  async get(col: Collection, agentId: string): Promise<RoutingContextDoc | null> {
    const cached = this.cache.get(agentId);
    if (cached && Date.now() - cached.loadedAt < this.ttlMs) {
      return cached.doc;
    }
    const doc = await getRoutingContext(col, agentId);
    if (doc) this.cache.set(agentId, { doc, loadedAt: Date.now() });
    return doc;
  }

  invalidate(agentId?: string) {
    if (agentId) {
      this.cache.delete(agentId);
    } else {
      this.cache.clear();
    }
  }
}

// ==========================================================================
// Model Normalization (reimplemented from core — plugin SDK doesn't expose)
// ==========================================================================

const PROVIDER_ALIASES: Record<string, string> = {
  "z.ai": "zai",
  "z-ai": "zai",
  "opencode-zen": "opencode",
  qwen: "qwen-portal",
  "kimi-code": "kimi-coding",
};

const ANTHROPIC_MODEL_ALIASES: Record<string, string> = {
  opus: "claude-opus-4-6",
  sonnet: "claude-sonnet-4-5",
  haiku: "claude-haiku-4-5",
  "opus-4.6": "claude-opus-4-6",
  "sonnet-4.5": "claude-sonnet-4-5",
  "haiku-4.5": "claude-haiku-4-5",
};

export function normalizeProviderId(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  return PROVIDER_ALIASES[normalized] ?? normalized;
}

export type ModelRef = { provider: string; model: string };

export function parseModelRef(raw: string, defaultProvider: string): ModelRef | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const slashIdx = trimmed.indexOf("/");
  if (slashIdx > 0) {
    const provider = normalizeProviderId(trimmed.slice(0, slashIdx));
    let model = trimmed.slice(slashIdx + 1).toLowerCase();
    if (provider === "anthropic") {
      model = ANTHROPIC_MODEL_ALIASES[model] ?? model;
    }
    return { provider, model };
  }

  // Bare model name — check if it's an Anthropic alias
  const lower = trimmed.toLowerCase();
  const aliased = ANTHROPIC_MODEL_ALIASES[lower];
  if (aliased) return { provider: "anthropic", model: aliased };

  return { provider: normalizeProviderId(defaultProvider), model: lower };
}

const HARDCODED_CLI_PROVIDERS = new Set(["claude-cli", "codex-cli"]);

export function isCliProvider(provider: string, cfg?: OpenClawConfig): boolean {
  const normalized = normalizeProviderId(provider);
  if (HARDCODED_CLI_PROVIDERS.has(normalized)) return true;
  const backends = (cfg?.agents?.defaults as Record<string, unknown>)?.cliBackends;
  if (backends && typeof backends === "object") {
    return Object.keys(backends).some((key) => normalizeProviderId(key) === normalized);
  }
  return false;
}

// ==========================================================================
// Model Discovery
// ==========================================================================

function collectModelRefs(cfg: OpenClawConfig, agentId: string): string[] {
  const refs: string[] = [];
  const defaults = cfg.agents?.defaults;

  // Primary model (per-agent or global)
  const agentEntry = (cfg.agents as Record<string, unknown>)?.list as
    | Array<Record<string, unknown>>
    | undefined;
  const agentCfg = agentEntry?.find((a) => a.id === agentId);

  if (agentCfg?.model) {
    if (typeof agentCfg.model === "string") {
      refs.push(agentCfg.model);
    } else if (typeof agentCfg.model === "object") {
      const m = agentCfg.model as Record<string, unknown>;
      if (typeof m.primary === "string") refs.push(m.primary);
      if (Array.isArray(m.fallbacks)) {
        for (const f of m.fallbacks) {
          if (typeof f === "string") refs.push(f);
        }
      }
    }
  }

  // Global defaults
  const defaultModel = defaults?.model;
  if (defaultModel && typeof defaultModel === "object") {
    const dm = defaultModel as Record<string, unknown>;
    if (typeof dm.primary === "string") refs.push(dm.primary);
    if (Array.isArray(dm.fallbacks)) {
      for (const f of dm.fallbacks) {
        if (typeof f === "string") refs.push(f);
      }
    }
  }

  // CLI backends
  const backends = (defaults as Record<string, unknown>)?.cliBackends;
  if (backends && typeof backends === "object") {
    for (const key of Object.keys(backends)) {
      refs.push(`${key}/default`);
    }
  }

  return refs;
}

function classifyModel(
  ref: ModelRef,
  heuristics: Record<string, TierHeuristic>,
  cfg?: OpenClawConfig,
): { tier: string; capabilities: TierHeuristic["default_capabilities"] } {
  if (isCliProvider(ref.provider, cfg)) {
    const heavy = heuristics.heavy;
    return {
      tier: "heavy",
      capabilities: heavy?.default_capabilities ?? {
        tools: true,
        filesystem: true,
        code_execution: true,
        reasoning: "deep" as const,
      },
    };
  }

  const canonical = `${ref.provider}/${ref.model}`;
  for (const [tier, h] of Object.entries(heuristics)) {
    if (h.match.some((prefix) => canonical.startsWith(prefix))) {
      return { tier, capabilities: h.default_capabilities };
    }
    if (h.indicators.some((ind) => ref.model.includes(ind))) {
      return { tier, capabilities: h.default_capabilities };
    }
  }

  // Unknown → heavy (safe default)
  const heavy = heuristics.heavy;
  return {
    tier: "heavy",
    capabilities: heavy?.default_capabilities ?? {
      tools: true,
      filesystem: true,
      code_execution: true,
      reasoning: "deep" as const,
    },
  };
}

export function computeModelsHash(models: RoutingModel[]): string {
  const ids = models
    .map((m) => m.id)
    .sort()
    .join("|");
  let hash = 0;
  for (let i = 0; i < ids.length; i++) {
    hash = ((hash << 5) - hash + ids.charCodeAt(i)) | 0;
  }
  return hash.toString(36);
}

export function discoverModels(
  cfg: OpenClawConfig,
  agentId: string,
  heuristics: Record<string, TierHeuristic>,
): RoutingModel[] {
  const rawRefs = collectModelRefs(cfg, agentId);
  const defaultProvider = (cfg.agents?.defaults?.model as Record<string, unknown>)?.primary
    ? (parseModelRef(
        (cfg.agents!.defaults!.model as Record<string, unknown>).primary as string,
        "anthropic",
      )?.provider ?? "anthropic")
    : "anthropic";

  const seen = new Set<string>();
  const models: RoutingModel[] = [];

  for (const raw of rawRefs) {
    const ref = parseModelRef(raw, defaultProvider);
    if (!ref) continue;

    const id = `${ref.provider}/${ref.model}`;
    if (seen.has(id)) continue;
    seen.add(id);

    const { tier, capabilities } = classifyModel(ref, heuristics, cfg);
    models.push({
      id,
      alias: ref.model,
      tier: tier as RoutingModel["tier"],
      capabilities: { ...capabilities },
      use_when: [],
      never_when: [],
    });
  }

  return models;
}

export function mergeModelsIncremental(
  existing: RoutingModel[],
  discovered: RoutingModel[],
): RoutingModel[] {
  const existingById = new Map(existing.map((m) => [m.id, m]));
  const discoveredIds = new Set(discovered.map((m) => m.id));
  const result: RoutingModel[] = [];

  // Keep existing models, preserving user edits
  for (const m of existing) {
    if (discoveredIds.has(m.id)) {
      result.push(m); // keep user edits
    } else {
      result.push({ ...m, active: false }); // mark removed
    }
  }

  // Add newly discovered
  for (const m of discovered) {
    if (!existingById.has(m.id)) {
      result.push(m);
    }
  }

  return result;
}
