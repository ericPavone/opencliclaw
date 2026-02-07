import { describe, it, expect, vi } from "vitest";
import {
  getRoutingContext,
  storeRoutingContext,
  getModelByTier,
  RoutingCache,
  normalizeProviderId,
  parseModelRef,
  isCliProvider,
  computeModelsHash,
  discoverModels,
  mergeModelsIncremental,
  type RoutingModel,
  type RoutingContextDoc,
} from "../../src/collections/routing.js";
import { mockCollection } from "../test-helpers.js";

// ============================================================================
// CRUD
// ============================================================================

describe("routing CRUD", () => {
  it("getRoutingContext returns null when empty", async () => {
    const col = mockCollection();
    const result = await getRoutingContext(col);
    expect(result).toBeNull();
  });

  it("getRoutingContext queries by agent_id", async () => {
    const doc = { agent_id: "myagent", version: 1 };
    const col = mockCollection({ findOne: vi.fn().mockResolvedValue(doc) });
    const result = await getRoutingContext(col, "myagent");
    expect(result).toEqual(doc);
    expect(col.findOne).toHaveBeenCalledWith({ agent_id: "myagent" });
  });

  it("getRoutingContext defaults to 'default' agent", async () => {
    const col = mockCollection();
    await getRoutingContext(col);
    expect(col.findOne).toHaveBeenCalledWith({ agent_id: "default" });
  });

  it("storeRoutingContext upserts", async () => {
    const col = mockCollection({
      updateOne: vi.fn().mockResolvedValue({ upsertedId: "new-id" }),
    });
    const result = await storeRoutingContext(col, {
      agent_id: "default",
      version: 5,
      models: [],
      classification: { categories: {}, indicators: {}, path_patterns: [], code_block_regex: "" },
      routing: {
        default_tier: "heavy",
        ambiguous_action: "no_override",
        capability_constraint: "",
        rules: [],
      },
      escalation: { triggers: [], de_escalation_triggers: [] },
    });
    expect(result.action).toBe("created");
    expect(col.updateOne).toHaveBeenCalled();
  });

  it("storeRoutingContext reports updated when no upsert", async () => {
    const col = mockCollection({
      updateOne: vi.fn().mockResolvedValue({ upsertedId: null }),
    });
    const result = await storeRoutingContext(col, {
      agent_id: "default",
      version: 5,
      models: [],
      classification: { categories: {}, indicators: {}, path_patterns: [], code_block_regex: "" },
      routing: {
        default_tier: "heavy",
        ambiguous_action: "no_override",
        capability_constraint: "",
        rules: [],
      },
      escalation: { triggers: [], de_escalation_triggers: [] },
    });
    expect(result.action).toBe("updated");
  });
});

// ============================================================================
// getModelByTier
// ============================================================================

describe("getModelByTier", () => {
  const doc = {
    models: [
      {
        id: "google/gemini-3-pro",
        alias: "gemini-3-pro",
        tier: "fast" as const,
        capabilities: {
          tools: false,
          filesystem: false,
          code_execution: false,
          reasoning: "light" as const,
        },
        use_when: [],
        never_when: [],
      },
      {
        id: "anthropic/claude-sonnet-4-5",
        alias: "claude-sonnet-4-5",
        tier: "mid" as const,
        capabilities: {
          tools: true,
          filesystem: true,
          code_execution: true,
          reasoning: "standard" as const,
        },
        use_when: [],
        never_when: [],
      },
      {
        id: "anthropic/claude-opus-4-6",
        alias: "claude-opus-4-6",
        tier: "heavy" as const,
        capabilities: {
          tools: true,
          filesystem: true,
          code_execution: true,
          reasoning: "deep" as const,
        },
        use_when: [],
        never_when: [],
      },
      {
        id: "anthropic/old-model",
        alias: "old-model",
        tier: "mid" as const,
        capabilities: {
          tools: true,
          filesystem: true,
          code_execution: true,
          reasoning: "standard" as const,
        },
        use_when: [],
        never_when: [],
        active: false,
      },
    ],
  } as unknown as RoutingContextDoc;

  it("returns model matching tier", () => {
    expect(getModelByTier(doc, "fast")?.id).toBe("google/gemini-3-pro");
    expect(getModelByTier(doc, "mid")?.id).toBe("anthropic/claude-sonnet-4-5");
    expect(getModelByTier(doc, "heavy")?.id).toBe("anthropic/claude-opus-4-6");
  });

  it("returns null for unknown tier", () => {
    expect(getModelByTier(doc, "ultra")).toBeNull();
  });

  it("skips inactive models", () => {
    const onlyInactive = {
      models: [
        {
          id: "x/y",
          tier: "mid",
          active: false,
          capabilities: {
            tools: true,
            filesystem: true,
            code_execution: true,
            reasoning: "standard",
          },
          use_when: [],
          never_when: [],
        },
      ],
    } as unknown as RoutingContextDoc;
    expect(getModelByTier(onlyInactive, "mid")).toBeNull();
  });
});

// ============================================================================
// Model Normalization
// ============================================================================

describe("normalizeProviderId", () => {
  it("normalizes known aliases", () => {
    expect(normalizeProviderId("z.ai")).toBe("zai");
    expect(normalizeProviderId("Z-AI")).toBe("zai");
    expect(normalizeProviderId("opencode-zen")).toBe("opencode");
    expect(normalizeProviderId("qwen")).toBe("qwen-portal");
  });

  it("passes through unknown providers", () => {
    expect(normalizeProviderId("anthropic")).toBe("anthropic");
    expect(normalizeProviderId("Google")).toBe("google");
  });
});

describe("parseModelRef", () => {
  it("parses provider/model format", () => {
    expect(parseModelRef("anthropic/claude-opus-4-6", "anthropic")).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-6",
    });
  });

  it("resolves Anthropic model aliases", () => {
    expect(parseModelRef("anthropic/opus", "anthropic")).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-6",
    });
    expect(parseModelRef("anthropic/opus-4.6", "anthropic")).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-6",
    });
  });

  it("resolves bare model aliases", () => {
    expect(parseModelRef("opus", "google")).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-6",
    });
    expect(parseModelRef("haiku", "google")).toEqual({
      provider: "anthropic",
      model: "claude-haiku-4-5",
    });
  });

  it("uses default provider for bare unknown models", () => {
    expect(parseModelRef("gemini-3-pro", "google")).toEqual({
      provider: "google",
      model: "gemini-3-pro",
    });
  });

  it("normalizes provider aliases", () => {
    expect(parseModelRef("z.ai/glm-4.7", "anthropic")).toEqual({
      provider: "zai",
      model: "glm-4.7",
    });
  });

  it("returns null for empty string", () => {
    expect(parseModelRef("", "anthropic")).toBeNull();
    expect(parseModelRef("   ", "anthropic")).toBeNull();
  });
});

describe("isCliProvider", () => {
  it("detects hardcoded CLI providers", () => {
    expect(isCliProvider("claude-cli")).toBe(true);
    expect(isCliProvider("codex-cli")).toBe(true);
  });

  it("detects custom CLI backends from config", () => {
    const cfg = {
      agents: {
        defaults: {
          cliBackends: { "my-cli": {} },
        },
      },
    } as any;
    expect(isCliProvider("my-cli", cfg)).toBe(true);
    expect(isCliProvider("other-cli", cfg)).toBe(false);
  });

  it("returns false for API providers", () => {
    expect(isCliProvider("anthropic")).toBe(false);
    expect(isCliProvider("google")).toBe(false);
  });
});

// ============================================================================
// Model Discovery
// ============================================================================

describe("computeModelsHash", () => {
  it("produces deterministic hash", () => {
    const models: RoutingModel[] = [
      {
        id: "a/b",
        alias: "b",
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
        id: "c/d",
        alias: "d",
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
    ];
    const h1 = computeModelsHash(models);
    const h2 = computeModelsHash(models);
    expect(h1).toBe(h2);
  });

  it("order-independent (sorted internally)", () => {
    const m1: RoutingModel[] = [
      {
        id: "a/b",
        alias: "b",
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
        id: "c/d",
        alias: "d",
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
    ];
    const m2 = [...m1].reverse();
    expect(computeModelsHash(m1)).toBe(computeModelsHash(m2));
  });

  it("different models produce different hashes", () => {
    const m1: RoutingModel[] = [
      {
        id: "a/b",
        alias: "b",
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
    ];
    const m2: RoutingModel[] = [
      {
        id: "x/y",
        alias: "y",
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
    ];
    expect(computeModelsHash(m1)).not.toBe(computeModelsHash(m2));
  });
});

describe("discoverModels", () => {
  const heuristics = {
    fast: {
      match: ["google/"],
      indicators: ["gemini", "flash"],
      default_capabilities: {
        tools: false,
        filesystem: false,
        code_execution: false,
        reasoning: "light" as const,
      },
    },
    mid: {
      match: ["anthropic/claude-sonnet", "anthropic/claude-haiku"],
      indicators: ["sonnet", "haiku"],
      default_capabilities: {
        tools: true,
        filesystem: true,
        code_execution: true,
        reasoning: "standard" as const,
      },
    },
    heavy: {
      match: ["anthropic/claude-opus", "claude-cli/"],
      indicators: ["opus", "codex"],
      default_capabilities: {
        tools: true,
        filesystem: true,
        code_execution: true,
        reasoning: "deep" as const,
      },
    },
  };

  it("discovers models from config defaults", () => {
    const cfg = {
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-opus-4-6",
            fallbacks: ["google/gemini-3-pro-preview"],
          },
        },
      },
    } as any;
    const models = discoverModels(cfg, "default", heuristics);
    expect(models).toHaveLength(2);
    expect(models[0].id).toBe("anthropic/claude-opus-4-6");
    expect(models[0].tier).toBe("heavy");
    expect(models[1].id).toBe("google/gemini-3-pro-preview");
    expect(models[1].tier).toBe("fast");
  });

  it("deduplicates models", () => {
    const cfg = {
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-opus-4-6",
            fallbacks: ["anthropic/claude-opus-4-6"],
          },
        },
      },
    } as any;
    const models = discoverModels(cfg, "default", heuristics);
    expect(models).toHaveLength(1);
  });

  it("classifies CLI backends as heavy", () => {
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-6" },
          cliBackends: { "claude-cli": {} },
        },
      },
    } as any;
    const models = discoverModels(cfg, "default", heuristics);
    const cli = models.find((m) => m.id.startsWith("claude-cli/"));
    expect(cli).toBeDefined();
    expect(cli!.tier).toBe("heavy");
  });
});

describe("mergeModelsIncremental", () => {
  const base: RoutingModel[] = [
    {
      id: "a/b",
      alias: "b",
      tier: "fast",
      capabilities: { tools: false, filesystem: false, code_execution: false, reasoning: "light" },
      use_when: ["greetings"],
      never_when: [],
    },
    {
      id: "c/d",
      alias: "d",
      tier: "heavy",
      capabilities: { tools: true, filesystem: true, code_execution: true, reasoning: "deep" },
      use_when: [],
      never_when: [],
    },
  ];

  it("preserves existing models that are still discovered", () => {
    const discovered: RoutingModel[] = [
      {
        id: "a/b",
        alias: "b",
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
    ];
    const merged = mergeModelsIncremental(base, discovered);
    const ab = merged.find((m) => m.id === "a/b");
    expect(ab!.use_when).toEqual(["greetings"]); // user edit preserved
  });

  it("marks removed models as inactive", () => {
    const discovered: RoutingModel[] = [
      {
        id: "a/b",
        alias: "b",
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
    ];
    const merged = mergeModelsIncremental(base, discovered);
    const cd = merged.find((m) => m.id === "c/d");
    expect(cd!.active).toBe(false);
  });

  it("adds newly discovered models", () => {
    const discovered: RoutingModel[] = [
      ...base,
      {
        id: "x/y",
        alias: "y",
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
    ];
    const merged = mergeModelsIncremental(base, discovered);
    expect(merged).toHaveLength(3);
    const xy = merged.find((m) => m.id === "x/y");
    expect(xy).toBeDefined();
  });
});

// ============================================================================
// RoutingCache
// ============================================================================

describe("RoutingCache", () => {
  it("caches and returns doc within TTL", async () => {
    const doc = { agent_id: "default", version: 1, models: [] } as unknown as RoutingContextDoc;
    const col = mockCollection({ findOne: vi.fn().mockResolvedValue(doc) });
    const cache = new RoutingCache(5000);

    const r1 = await cache.get(col, "default");
    const r2 = await cache.get(col, "default");
    expect(r1).toEqual(doc);
    expect(r2).toEqual(doc);
    expect(col.findOne).toHaveBeenCalledTimes(1); // only 1 DB call
  });

  it("invalidate clears specific agent", async () => {
    const doc = { agent_id: "default", version: 1 } as unknown as RoutingContextDoc;
    const col = mockCollection({ findOne: vi.fn().mockResolvedValue(doc) });
    const cache = new RoutingCache(60000);

    await cache.get(col, "default");
    cache.invalidate("default");
    await cache.get(col, "default");
    expect(col.findOne).toHaveBeenCalledTimes(2);
  });

  it("invalidate() without arg clears all", async () => {
    const doc = { agent_id: "a", version: 1 } as unknown as RoutingContextDoc;
    const col = mockCollection({ findOne: vi.fn().mockResolvedValue(doc) });
    const cache = new RoutingCache(60000);

    await cache.get(col, "a"); // DB call #1 (miss)
    await cache.get(col, "b"); // DB call #2 (miss)
    cache.invalidate();
    await cache.get(col, "a"); // DB call #3 (cleared)
    await cache.get(col, "b"); // DB call #4 (cleared)
    expect(col.findOne).toHaveBeenCalledTimes(4);
  });
});
