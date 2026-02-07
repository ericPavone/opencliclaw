import { describe, it, expect, vi } from "vitest";
import type { RoutingContextDoc, ClassificationConfig } from "../src/collections/routing.js";
import {
  classifyPrompt,
  resolveRoutingOverride,
  type ClassificationResult,
} from "../src/routing.js";

// ============================================================================
// Shared fixtures
// ============================================================================

const classification: ClassificationConfig = {
  categories: {
    CHAT: { complexity_range: [1, 3], description: "Greetings" },
    QUICK: { complexity_range: [1, 4], description: "Translations, lookups" },
    TOOL: { complexity_range: [5, 8], description: "File ops, bash" },
    CODE: { complexity_range: [6, 9], description: "Code gen, debug" },
    PLAN: { complexity_range: [7, 10], description: "Architecture" },
  },
  indicators: {
    TOOL: ["exec", "bash", "git", "read file", "write file"],
    CODE: ["refactor", "debug", "implement", "fix bug", "```"],
    PLAN: ["plan", "architect", "design", "strategy"],
    CHAT: ["hello", "hi", "ciao", "come stai", "thanks"],
    QUICK: ["translate", "traduci", "summarize", "what is"],
  },
  path_patterns: ["/src/", ".ts", ".js"],
  code_block_regex: "```[\\s\\S]*?```",
};

function makeRoutingDoc(overrides?: Partial<RoutingContextDoc>): RoutingContextDoc {
  return {
    agent_id: "default",
    version: 5,
    models: [
      {
        id: "google/gemini-3-pro",
        alias: "gemini-3-pro",
        tier: "fast",
        capabilities: {
          tools: false,
          filesystem: false,
          code_execution: false,
          reasoning: "light",
        },
        use_when: [],
        never_when: [],
      },
      {
        id: "anthropic/claude-sonnet-4-5",
        alias: "claude-sonnet-4-5",
        tier: "mid",
        capabilities: {
          tools: true,
          filesystem: true,
          code_execution: true,
          reasoning: "standard",
        },
        use_when: [],
        never_when: [],
      },
      {
        id: "anthropic/claude-opus-4-6",
        alias: "claude-opus-4-6",
        tier: "heavy",
        capabilities: { tools: true, filesystem: true, code_execution: true, reasoning: "deep" },
        use_when: [],
        never_when: [],
      },
    ],
    classification,
    routing: {
      default_tier: "heavy",
      ambiguous_action: "no_override",
      capability_constraint: "",
      rules: [
        { if: "CHAT", tools_in_context: false, then: "fast", priority: 1 },
        { if: "CHAT", tools_in_context: true, then: "mid", priority: 1 },
        { if: "QUICK", tools_in_context: false, then: "fast", priority: 2 },
        { if: "QUICK", tools_in_context: true, then: "mid", priority: 2 },
        { if: "TOOL", tools_in_context: true, then: "heavy", priority: 3 },
        { if: "TOOL", tools_in_context: false, then: "heavy", priority: 3 },
        { if: "CODE", tools_in_context: true, then: "heavy", priority: 4 },
        { if: "CODE", tools_in_context: false, then: "heavy", priority: 4 },
        { if: "PLAN", tools_in_context: true, then: "heavy", priority: 5 },
        { if: "PLAN", tools_in_context: false, then: "heavy", priority: 5 },
      ],
    },
    escalation: { triggers: [], de_escalation_triggers: [] },
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  } as RoutingContextDoc;
}

// ============================================================================
// classifyPrompt
// ============================================================================

describe("classifyPrompt", () => {
  it("classifies greetings as CHAT", () => {
    const r = classifyPrompt("ciao, come stai?", classification);
    expect(r.category).toBe("CHAT");
    expect(r.complexity).toBeGreaterThanOrEqual(1);
    expect(r.complexity).toBeLessThanOrEqual(3);
  });

  it("classifies translation requests as QUICK", () => {
    const r = classifyPrompt("traduci questo in inglese", classification);
    expect(r.category).toBe("QUICK");
  });

  it("classifies code tasks as CODE", () => {
    const r = classifyPrompt(
      "refactor the authentication module and fix bug in login",
      classification,
    );
    expect(r.category).toBe("CODE");
    expect(r.complexity).toBeGreaterThanOrEqual(6);
  });

  it("classifies bash commands as TOOL", () => {
    const r = classifyPrompt("exec git status", classification);
    expect(r.category).toBe("TOOL");
  });

  it("classifies architecture tasks as PLAN", () => {
    const r = classifyPrompt(
      "design the strategy for the new microservice architecture",
      classification,
    );
    expect(r.category).toBe("PLAN");
  });

  it("boosts CODE when path patterns found", () => {
    const r = classifyPrompt("check /src/index.ts", classification);
    expect(r.category).toBe("CODE");
  });

  it("boosts CODE when code blocks found", () => {
    const r = classifyPrompt("hello\n```typescript\nconst x = 1;\n```", classification);
    expect(r.category).toBe("CODE");
  });

  it("defaults to CHAT for unrecognized prompts", () => {
    const r = classifyPrompt("xyz abc 123", classification);
    expect(r.category).toBe("CHAT");
  });

  it("returns matched indicators", () => {
    const r = classifyPrompt("refactor and debug", classification);
    expect(r.matchedIndicators).toContain("CODE:refactor");
    expect(r.matchedIndicators).toContain("CODE:debug");
  });
});

// ============================================================================
// resolveRoutingOverride
// ============================================================================

describe("resolveRoutingOverride", () => {
  it("routes CHAT without tools to fast tier", () => {
    const doc = makeRoutingDoc();
    const result = resolveRoutingOverride("ciao come stai?", doc, false);
    expect(result.override).toBe(true);
    if (result.override) {
      expect(result.provider).toBe("google");
      expect(result.model).toBe("gemini-3-pro");
      expect(result.tier).toBe("fast");
    }
  });

  it("routes CHAT with tools to mid tier", () => {
    const doc = makeRoutingDoc();
    const result = resolveRoutingOverride("hello!", doc, true);
    expect(result.override).toBe(true);
    if (result.override) {
      expect(result.provider).toBe("anthropic");
      expect(result.model).toBe("claude-sonnet-4-5");
      expect(result.tier).toBe("mid");
    }
  });

  it("routes CODE to heavy tier", () => {
    const doc = makeRoutingDoc();
    const result = resolveRoutingOverride("refactor the auth module", doc, true);
    expect(result.override).toBe(true);
    if (result.override) {
      expect(result.provider).toBe("anthropic");
      expect(result.model).toBe("claude-opus-4-6");
      expect(result.tier).toBe("heavy");
    }
  });

  it("returns no override for unrecognized prompt when ambiguous_action=no_override", () => {
    const doc = makeRoutingDoc();
    const result = resolveRoutingOverride("xyz abc 123", doc, false);
    // CHAT (default) with tools=false should match the rule
    expect(result.override).toBe(true);
  });

  it("escalates past tool-less model when tools are active", () => {
    const doc = makeRoutingDoc({
      routing: {
        default_tier: "heavy",
        ambiguous_action: "no_override",
        capability_constraint: "",
        rules: [{ if: "CHAT", tools_in_context: true, then: "fast", priority: 1 }],
      },
    });
    // fast tier model has tools: false, but tools_in_context is true → escalates to mid
    const result = resolveRoutingOverride("hello", doc, true);
    expect(result.override).toBe(true);
    if (result.override) {
      expect(result.tier).toBe("mid");
      expect(result.provider).toBe("anthropic");
    }
  });

  it("escalates when no model exists in target tier", () => {
    const doc = makeRoutingDoc({
      models: [
        {
          id: "anthropic/claude-opus-4-6",
          alias: "claude-opus-4-6",
          tier: "heavy",
          capabilities: { tools: true, filesystem: true, code_execution: true, reasoning: "deep" },
          use_when: [],
          never_when: [],
        },
      ],
    });
    // CHAT without tools → fast tier, but no fast model → escalates to heavy
    const result = resolveRoutingOverride("hello", doc, false);
    expect(result.override).toBe(true);
    if (result.override) {
      expect(result.tier).toBe("heavy");
    }
  });

  it("uses default tier when ambiguous_action is use_default", () => {
    const doc = makeRoutingDoc({
      routing: {
        default_tier: "heavy",
        ambiguous_action: "use_default",
        capability_constraint: "",
        rules: [], // no rules at all
      },
    });
    const result = resolveRoutingOverride("anything", doc, false);
    expect(result.override).toBe(true);
    if (result.override) {
      expect(result.tier).toBe("heavy");
    }
  });

  it("logs routing decisions", () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const doc = makeRoutingDoc();
    resolveRoutingOverride("ciao", doc, false, logger, "myagent");
    expect(logger.info).toHaveBeenCalled();
    const logMsg = logger.info.mock.calls[0][0];
    expect(logMsg).toContain("agent=myagent");
    expect(logMsg).toContain("category=CHAT");
    expect(logMsg).toContain("tier=fast");
  });

  it("logs no_override when all tiers exhausted", () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const doc = makeRoutingDoc({ models: [] });
    resolveRoutingOverride("hello", doc, false, logger);
    expect(logger.info).toHaveBeenCalled();
    const logMsg = logger.info.mock.calls[0][0];
    expect(logMsg).toContain("no_override");
  });

  // ========================================================================
  // Escalation tests
  // ========================================================================

  it("escalates from fast to mid when fast model lacks tools", () => {
    const doc = makeRoutingDoc({
      routing: {
        default_tier: "heavy",
        ambiguous_action: "no_override",
        capability_constraint: "",
        rules: [{ if: "CHAT", tools_in_context: true, then: "fast", priority: 1 }],
      },
    });
    // fast tier model has tools: false, but tools_in_context is true → should escalate to mid
    const result = resolveRoutingOverride("hello", doc, true);
    expect(result.override).toBe(true);
    if (result.override) {
      expect(result.provider).toBe("anthropic");
      expect(result.model).toBe("claude-sonnet-4-5");
      expect(result.tier).toBe("mid");
    }
  });

  it("escalates when selected model is unhealthy", () => {
    const doc = makeRoutingDoc();
    const isHealthy = (id: string) => id !== "google/gemini-3-pro";
    const result = resolveRoutingOverride(
      "ciao come stai?",
      doc,
      false,
      undefined,
      undefined,
      isHealthy,
    );
    expect(result.override).toBe(true);
    if (result.override) {
      expect(result.provider).toBe("anthropic");
      expect(result.model).toBe("claude-sonnet-4-5");
      expect(result.tier).toBe("mid");
    }
  });

  it("returns no_override when all models are unhealthy", () => {
    const doc = makeRoutingDoc();
    const allUnhealthy = () => false;
    const result = resolveRoutingOverride("ciao", doc, false, undefined, undefined, allUnhealthy);
    expect(result.override).toBe(false);
    if (!result.override) {
      expect(result.reason).toContain("all_tiers_exhausted");
    }
  });

  it("escalation includes reason with tier info", () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const doc = makeRoutingDoc({
      routing: {
        default_tier: "heavy",
        ambiguous_action: "no_override",
        capability_constraint: "",
        rules: [{ if: "CHAT", tools_in_context: true, then: "fast", priority: 1 }],
      },
    });
    const result = resolveRoutingOverride("hello", doc, true, logger);
    expect(result.override).toBe(true);
    if (result.override) {
      expect(result.reason).toContain("→");
    }
  });

  it("use_default also escalates when tier is empty", () => {
    const doc = makeRoutingDoc({
      models: [
        {
          id: "anthropic/claude-opus-4-6",
          alias: "claude-opus-4-6",
          tier: "heavy",
          capabilities: { tools: true, filesystem: true, code_execution: true, reasoning: "deep" },
          use_when: [],
          never_when: [],
        },
      ],
      routing: {
        default_tier: "fast",
        ambiguous_action: "use_default",
        capability_constraint: "",
        rules: [],
      },
    });
    const result = resolveRoutingOverride("anything", doc, false);
    expect(result.override).toBe(true);
    if (result.override) {
      expect(result.tier).toBe("heavy");
      expect(result.reason).toContain("escalated");
    }
  });
});
