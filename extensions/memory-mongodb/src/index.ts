import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import fs from "node:fs/promises";
import path from "node:path";
import { stringEnum } from "openclaw/plugin-sdk";
import { registerBootstrapHook } from "./bootstrap-hook.js";
import * as agentConfig from "./collections/agent-config.js";
import * as guidelines from "./collections/guidelines.js";
import * as memories from "./collections/memories.js";
import {
  getRoutingContext,
  storeRoutingContext,
  discoverModels,
  mergeModelsIncremental,
  computeModelsHash,
  RoutingCache,
} from "./collections/routing.js";
import * as seeds from "./collections/seeds.js";
import * as skills from "./collections/skills.js";
import { mongodbConfigSchema } from "./config.js";
import { MongoMemoryDB, ALL_COLLECTIONS, type CollectionName } from "./db.js";
import { createMigrator } from "./migrate.js";
import { ProviderHealthTracker } from "./provider-health.js";
import { resolveRoutingOverride } from "./routing.js";

const COLLECTION_NAMES = ["memories", "guidelines", "seeds", "config", "skills"] as const;

function resolveCollectionName(input: string): CollectionName {
  if (input === "config") return "agent_config";
  if (ALL_COLLECTIONS.includes(input as CollectionName)) return input as CollectionName;
  throw new Error(`Unknown collection: ${input}. Valid: ${COLLECTION_NAMES.join(", ")}`);
}

// Rule-based capture filter (aligned with memory-lancedb pattern)
const MEMORY_TRIGGERS = [
  /remember|ricorda|zapamatuj/i,
  /prefer|preferisco|radši/i,
  /decided|deciso|rozhodli/i,
  /\+\d{10,}/,
  /[\w.-]+@[\w.-]+\.\w+/,
  /my\s+\w+\s+is|is\s+my/i,
  /i (like|prefer|hate|love|want|need)/i,
  /always|never|important|sempre|mai/i,
  // Italian conversational triggers
  /mi piace|non mi piace|odio|amo|vorrei|ho bisogno/i,
  /il mio\s+\w+\s+[eè]|si chiama|mi chiamo/i,
  /uso sempre|non uso mai|di solito/i,
  /ho scelto|abbiamo deciso|usiamo|useremo/i,
  /nota bene|importante|attenzione|ricordati/i,
  // Generic declarative facts (any language)
  /(?:^|\.\s*)(?:the|il|la|lo|le|i|gli)\s+\w+\s+(?:is|are|was|were|[eè]|sono|era|erano)\b/i,
  /(?:we|noi)\s+(?:use|using|utilizziam|usiam)/i,
  /(?:project|progetto|app|api|server|database|db)\s+\w+\s+(?:is|runs|uses|[eè]|usa|gira)/i,
];

function shouldCapture(text: string): boolean {
  if (text.length < 10 || text.length > 500) return false;
  if (text.includes("<relevant-memories>")) return false;
  if (text.startsWith("<") && text.includes("</")) return false;
  if (text.includes("**") && text.includes("\n-")) return false;
  const emojiCount = (text.match(/[\u{1F300}-\u{1F9FF}]/gu) || []).length;
  if (emojiCount > 3) return false;
  return MEMORY_TRIGGERS.some((r) => r.test(text));
}

function detectCategory(text: string): string {
  const lower = text.toLowerCase();
  if (/prefer|like|love|hate|want|mi piace|non mi piace|odio|amo|vorrei|preferisco/i.test(lower))
    return "preference";
  if (/decided|will use|budeme|ho scelto|deciso|usiamo|useremo|abbiamo deciso/i.test(lower))
    return "decision";
  if (/\+\d{10,}|@[\w.-]+\.\w+|is called|si chiama|mi chiamo/i.test(lower)) return "entity";
  if (/\bis\b|\bare\b|\bhas\b|\bhave\b|\b[eè]\b|\bsono\b|\bha\b|\bhanno\b/i.test(lower))
    return "fact";
  return "note";
}

const memoryMongoDBPlugin = {
  id: "memory-mongodb",
  name: "Memory (MongoDB)",
  description: "MongoDB-backed structured knowledge management with 5 collections",
  kind: "memory" as const,
  configSchema: mongodbConfigSchema,

  register(api: OpenClawPluginApi) {
    const cfg = mongodbConfigSchema.parse(api.pluginConfig);
    const db = new MongoMemoryDB(cfg);

    api.logger.info(`memory-mongodb: registered (db: ${cfg.database}, lazy init)`);

    // ========================================================================
    // Tools
    // ========================================================================

    api.registerTool(
      {
        name: "mongobrain_search",
        label: "MongoBrain Search",
        description:
          "Search across MongoDB knowledge collections (memories, guidelines, seeds, config, skills). Returns text-search ranked results.",
        parameters: Type.Object({
          query: Type.String({ description: "Search query" }),
          collection: Type.Optional(stringEnum(COLLECTION_NAMES as unknown as readonly string[])),
          domain: Type.Optional(Type.String({ description: "Filter by domain" })),
          limit: Type.Optional(Type.Number({ description: "Max results (default: 10)" })),
        }),
        async execute(_toolCallId, params) {
          const {
            query,
            collection,
            domain,
            limit = 10,
          } = params as {
            query: string;
            collection?: string;
            domain?: string;
            limit?: number;
          };

          if (collection) {
            const colName = resolveCollectionName(collection);
            const col = await db.getCollection(colName);

            let results: Array<Record<string, unknown>>;
            switch (colName) {
              case "memories":
                results = await memories.search(col, { query, domain, limit });
                break;
              case "guidelines":
                results = await guidelines.search(col, { query, domain, limit });
                break;
              case "seeds":
                results = await seeds.search(col, { query, domain, limit });
                break;
              case "agent_config":
                results = await agentConfig.search(col, { query, agentId: cfg.agentId, limit });
                break;
              case "skills":
                results = await skills.search(col, { query, limit });
                break;
              default:
                results = [];
            }

            return {
              content: [
                {
                  type: "text",
                  text:
                    results.length === 0
                      ? `No results in ${collection}.`
                      : `Found ${results.length} results in ${collection}:\n\n${formatResults(results)}`,
                },
              ],
              details: { count: results.length, collection },
            };
          }

          // Cross-collection search
          const allResults: Array<{ collection: string; results: Record<string, unknown>[] }> = [];
          for (const name of ALL_COLLECTIONS) {
            const col = await db.getCollection(name);
            const displayName = name === "agent_config" ? "config" : name;
            try {
              const searchParams = { query, domain, limit: Math.min(limit, 5) };
              let results: Record<string, unknown>[];
              switch (name) {
                case "memories":
                  results = await memories.search(col, searchParams);
                  break;
                case "guidelines":
                  results = await guidelines.search(col, searchParams);
                  break;
                case "seeds":
                  results = await seeds.search(col, searchParams);
                  break;
                case "agent_config":
                  results = await agentConfig.search(col, {
                    query,
                    agentId: cfg.agentId,
                    limit: Math.min(limit, 5),
                  });
                  break;
                case "skills":
                  results = await skills.search(col, { query, limit: Math.min(limit, 5) });
                  break;
                default:
                  results = [];
              }
              if (results.length > 0) {
                allResults.push({ collection: displayName, results });
              }
            } catch {
              // Collection may not have text index yet; skip
            }
          }

          const totalCount = allResults.reduce((sum, r) => sum + r.results.length, 0);
          if (totalCount === 0) {
            return {
              content: [{ type: "text", text: "No results found across any collection." }],
              details: { count: 0 },
            };
          }

          const text = allResults
            .map((r) => `## ${r.collection} (${r.results.length})\n${formatResults(r.results)}`)
            .join("\n\n");

          return {
            content: [{ type: "text", text: `Found ${totalCount} results:\n\n${text}` }],
            details: { count: totalCount, collections: allResults.map((r) => r.collection) },
          };
        },
      },
      { name: "mongobrain_search" },
    );

    api.registerTool(
      {
        name: "mongobrain_store",
        label: "MongoBrain Store",
        description:
          "Store a document in a MongoDB collection (memories, guidelines, seeds, config, skills).",
        parameters: Type.Object({
          collection: stringEnum(COLLECTION_NAMES as unknown as readonly string[]),
          content: Type.String({ description: "Main content" }),
          domain: Type.Optional(Type.String({ description: "Domain/category" })),
          title: Type.Optional(Type.String({ description: "Title (guidelines)" })),
          name: Type.Optional(Type.String({ description: "Name (seeds, skills)" })),
          description: Type.Optional(Type.String({ description: "Description" })),
          type: Type.Optional(Type.String({ description: "Config type (soul, identity, etc.)" })),
          category: Type.Optional(Type.String({ description: "Category (memories)" })),
          tags: Type.Optional(Type.Array(Type.String(), { description: "Tags" })),
          priority: Type.Optional(Type.Number({ description: "Priority (guidelines)" })),
          triggers: Type.Optional(Type.Array(Type.String(), { description: "Triggers (skills)" })),
        }),
        async execute(_toolCallId, params) {
          const p = params as Record<string, unknown>;
          const colName = resolveCollectionName(p.collection as string);
          const col = await db.getCollection(colName);

          switch (colName) {
            case "memories": {
              const result = await memories.store(col, {
                content: p.content as string,
                domain: (p.domain as string) ?? "general",
                category: p.category as string,
                tags: p.tags as string[],
                summary: p.description as string,
              });
              return {
                content: [
                  {
                    type: "text",
                    text:
                      result.action === "duplicate"
                        ? `Duplicate memory already exists.`
                        : `Memory stored successfully.`,
                  },
                ],
                details: { action: result.action },
              };
            }
            case "guidelines": {
              const result = await guidelines.store(col, {
                title: (p.title as string) ?? (p.name as string) ?? "Untitled",
                content: p.content as string,
                domain: (p.domain as string) ?? "general",
                tags: p.tags as string[],
                priority: p.priority as number,
              });
              return {
                content: [
                  {
                    type: "text",
                    text:
                      result.action === "duplicate"
                        ? `Duplicate guideline already exists.`
                        : `Guideline stored successfully.`,
                  },
                ],
                details: { action: result.action },
              };
            }
            case "seeds": {
              const result = await seeds.store(col, {
                name: (p.name as string) ?? "unnamed",
                description: (p.description as string) ?? "",
                content: p.content as string,
                domain: (p.domain as string) ?? "general",
                tags: p.tags as string[],
              });
              return {
                content: [
                  {
                    type: "text",
                    text:
                      result.action === "duplicate"
                        ? `Seed "${p.name}" already exists.`
                        : `Seed "${p.name}" stored successfully.`,
                  },
                ],
                details: { action: result.action },
              };
            }
            case "agent_config": {
              const cfgType = p.type as string;
              if (!cfgType || !(agentConfig.VALID_TYPES as readonly string[]).includes(cfgType)) {
                return {
                  content: [
                    {
                      type: "text",
                      text: `Invalid config type. Valid: ${agentConfig.VALID_TYPES.join(", ")}`,
                    },
                  ],
                  details: { error: "invalid_type" },
                };
              }
              const result = await agentConfig.store(col, {
                type: cfgType as agentConfig.AgentConfigType,
                agentId: cfg.agentId,
                content: p.content as string,
              });
              return {
                content: [
                  {
                    type: "text",
                    text: `Config "${cfgType}" ${result.action} for agent "${cfg.agentId}".`,
                  },
                ],
                details: { action: result.action, type: cfgType },
              };
            }
            case "skills": {
              const result = await skills.store(col, {
                name: (p.name as string) ?? "unnamed",
                description: (p.description as string) ?? "",
                promptBase: p.content as string,
                triggers: p.triggers as string[],
              });
              return {
                content: [
                  {
                    type: "text",
                    text:
                      result.action === "duplicate"
                        ? `Skill "${p.name}" already exists.`
                        : `Skill "${p.name}" stored successfully.`,
                  },
                ],
                details: { action: result.action },
              };
            }
            default:
              return {
                content: [{ type: "text", text: "Unknown collection." }],
                details: { error: "unknown_collection" },
              };
          }
        },
      },
      { name: "mongobrain_store" },
    );

    api.registerTool(
      {
        name: "mongobrain_get",
        label: "MongoBrain Get",
        description: "Get a specific document by name/type from a collection.",
        parameters: Type.Object({
          collection: stringEnum(COLLECTION_NAMES as unknown as readonly string[]),
          name: Type.Optional(Type.String({ description: "Name (seeds, skills)" })),
          type: Type.Optional(Type.String({ description: "Config type" })),
          agentId: Type.Optional(Type.String({ description: "Agent ID (config)" })),
        }),
        async execute(_toolCallId, params) {
          const p = params as Record<string, unknown>;
          const colName = resolveCollectionName(p.collection as string);
          const col = await db.getCollection(colName);

          switch (colName) {
            case "agent_config": {
              const docs = await agentConfig.getConfig(
                col,
                (p.agentId as string) ?? cfg.agentId,
                p.type as string,
              );
              if (docs.length === 0) {
                return {
                  content: [{ type: "text", text: "No config found." }],
                  details: { count: 0 },
                };
              }
              return {
                content: [
                  {
                    type: "text",
                    text: formatResults(docs as unknown as Record<string, unknown>[]),
                  },
                ],
                details: { count: docs.length },
              };
            }
            case "skills": {
              const doc = await skills.getSkill(col, (p.name as string) ?? "");
              if (!doc) {
                return {
                  content: [{ type: "text", text: `Skill "${p.name}" not found.` }],
                  details: { found: false },
                };
              }
              return {
                content: [
                  { type: "text", text: formatDoc(doc as unknown as Record<string, unknown>) },
                ],
                details: { found: true },
              };
            }
            case "seeds": {
              const doc = await col.findOne({ name: p.name });
              if (!doc) {
                return {
                  content: [{ type: "text", text: `Seed "${p.name}" not found.` }],
                  details: { found: false },
                };
              }
              return {
                content: [
                  { type: "text", text: formatDoc(doc as unknown as Record<string, unknown>) },
                ],
                details: { found: true },
              };
            }
            default: {
              const doc = await col.findOne(p.name ? { name: p.name } : {});
              return {
                content: [
                  {
                    type: "text",
                    text: doc ? formatDoc(doc as unknown as Record<string, unknown>) : "Not found.",
                  },
                ],
                details: { found: !!doc },
              };
            }
          }
        },
      },
      { name: "mongobrain_get" },
    );

    api.registerTool(
      {
        name: "mongobrain_forget",
        label: "MongoBrain Forget",
        description: "Delete or deactivate a document from a collection.",
        parameters: Type.Object({
          collection: stringEnum(COLLECTION_NAMES as unknown as readonly string[]),
          name: Type.Optional(Type.String({ description: "Name/title to match" })),
          id: Type.Optional(Type.String({ description: "Document _id" })),
          domain: Type.Optional(Type.String({ description: "Domain filter (guidelines)" })),
        }),
        async execute(_toolCallId, params) {
          const p = params as Record<string, unknown>;
          const colName = resolveCollectionName(p.collection as string);
          const col = await db.getCollection(colName);

          if (colName === "guidelines" && p.name) {
            const count = await guidelines.deactivate(col, p.name as string, p.domain as string);
            return {
              content: [
                {
                  type: "text",
                  text:
                    count > 0
                      ? `Deactivated ${count} guideline(s).`
                      : "No matching guideline found.",
                },
              ],
              details: { deactivated: count },
            };
          }

          if (colName === "skills" && p.name) {
            const ok = await skills.deactivate(col, p.name as string);
            return {
              content: [
                {
                  type: "text",
                  text: ok ? `Skill "${p.name}" deactivated.` : `Skill "${p.name}" not found.`,
                },
              ],
              details: { deactivated: ok },
            };
          }

          // Direct delete by id or name
          const filter: Record<string, unknown> = {};
          if (p.id) {
            const { ObjectId } = await import("mongodb");
            filter._id = new ObjectId(p.id as string);
          } else if (p.name) {
            filter.name = p.name;
            if (!filter.name) filter.title = p.name;
          } else {
            return {
              content: [{ type: "text", text: "Provide name or id to identify the document." }],
              details: { error: "missing_param" },
            };
          }

          const result = await col.deleteOne(filter);
          return {
            content: [
              {
                type: "text",
                text: result.deletedCount > 0 ? "Document deleted." : "No matching document found.",
              },
            ],
            details: { deleted: result.deletedCount },
          };
        },
      },
      { name: "mongobrain_forget" },
    );

    api.registerTool(
      {
        name: "mongobrain_skill_match",
        label: "MongoBrain Skill Match",
        description: "Find active skills matching a trigger keyword.",
        parameters: Type.Object({
          trigger: Type.String({ description: "Trigger keyword to match" }),
        }),
        async execute(_toolCallId, params) {
          const { trigger } = params as { trigger: string };
          const col = await db.getCollection("skills");
          const matches = await skills.matchByTrigger(col, trigger);

          if (matches.length === 0) {
            return {
              content: [{ type: "text", text: `No skill matches trigger "${trigger}".` }],
              details: { count: 0 },
            };
          }

          const text = matches
            .map((s) => `- **${s.name}**: ${s.description} (triggers: ${s.triggers.join(", ")})`)
            .join("\n");

          return {
            content: [
              { type: "text", text: `Found ${matches.length} matching skill(s):\n\n${text}` },
            ],
            details: { count: matches.length, skills: matches.map((s) => s.name) },
          };
        },
      },
      { name: "mongobrain_skill_match" },
    );

    api.registerTool(
      {
        name: "mongobrain_config_load",
        label: "MongoBrain Config Load",
        description: "Load agent configuration from MongoDB (all sections or a specific type).",
        parameters: Type.Object({
          agentId: Type.Optional(Type.String({ description: "Agent ID (default: configured)" })),
          type: Type.Optional(Type.String({ description: "Specific config type to load" })),
        }),
        async execute(_toolCallId, params) {
          const { agentId, type } = params as { agentId?: string; type?: string };
          const col = await db.getCollection("agent_config");
          const docs = await agentConfig.getConfig(col, agentId ?? cfg.agentId, type);

          if (docs.length === 0) {
            return {
              content: [{ type: "text", text: "No configuration found." }],
              details: { count: 0 },
            };
          }

          const text = docs
            .map(
              (d) =>
                `### ${d.type}\n\n${d.content.slice(0, 500)}${d.content.length > 500 ? "..." : ""}`,
            )
            .join("\n\n---\n\n");

          return {
            content: [
              {
                type: "text",
                text: `Agent "${agentId ?? cfg.agentId}" config (${docs.length} sections):\n\n${text}`,
              },
            ],
            details: { count: docs.length, types: docs.map((d) => d.type) },
          };
        },
      },
      { name: "mongobrain_config_load" },
    );

    // ========================================================================
    // CLI Commands
    // ========================================================================

    api.registerCli(
      ({ program }) => {
        const cmd = program.command("mongobrain").description("MongoDB memory plugin commands");

        cmd.hook("postAction", async () => {
          await db.close();
        });

        cmd
          .command("status")
          .description("Show connection status and collection counts")
          .action(async () => {
            const ok = await db.ping();
            if (!ok) {
              console.log("MongoDB: disconnected or unreachable");
              return;
            }
            const counts = await db.counts();
            console.log("MongoDB: connected");
            console.log(`Database: ${cfg.database}`);
            console.log(`Agent ID: ${cfg.agentId}`);
            for (const [name, count] of Object.entries(counts)) {
              console.log(`  ${name}: ${count} documents`);
            }
          });

        cmd
          .command("search")
          .description("Search across collections")
          .argument("<query>", "Search query")
          .option("--collection <name>", "Specific collection")
          .option("--domain <domain>", "Filter by domain")
          .option("--limit <n>", "Max results", "10")
          .action(
            async (
              query: string,
              opts: { collection?: string; domain?: string; limit: string },
            ) => {
              const limit = parseInt(opts.limit);
              if (opts.collection) {
                const colName = resolveCollectionName(opts.collection);
                const col = await db.getCollection(colName);
                let results: Record<string, unknown>[];
                switch (colName) {
                  case "memories":
                    results = await memories.search(col, { query, domain: opts.domain, limit });
                    break;
                  case "guidelines":
                    results = await guidelines.search(col, { query, domain: opts.domain, limit });
                    break;
                  case "seeds":
                    results = await seeds.search(col, { query, domain: opts.domain, limit });
                    break;
                  case "agent_config":
                    results = await agentConfig.search(col, { query, agentId: cfg.agentId, limit });
                    break;
                  case "skills":
                    results = await skills.search(col, { query, limit });
                    break;
                  default:
                    results = [];
                }
                console.log(JSON.stringify(results, jsonReplacer, 2));
              } else {
                for (const name of ALL_COLLECTIONS) {
                  const col = await db.getCollection(name);
                  try {
                    const searchParams = { query, domain: opts.domain, limit: Math.min(limit, 5) };
                    let results: Record<string, unknown>[];
                    switch (name) {
                      case "memories":
                        results = await memories.search(col, searchParams);
                        break;
                      case "guidelines":
                        results = await guidelines.search(col, searchParams);
                        break;
                      case "seeds":
                        results = await seeds.search(col, searchParams);
                        break;
                      case "agent_config":
                        results = await agentConfig.search(col, {
                          query,
                          agentId: cfg.agentId,
                          limit: Math.min(limit, 5),
                        });
                        break;
                      case "skills":
                        results = await skills.search(col, { query, limit: Math.min(limit, 5) });
                        break;
                      default:
                        results = [];
                    }
                    if (results.length > 0) {
                      console.log(`\n--- ${name} (${results.length}) ---`);
                      console.log(JSON.stringify(results, jsonReplacer, 2));
                    }
                  } catch {
                    // skip collections without text index
                  }
                }
              }
            },
          );

        cmd
          .command("store")
          .description("Store a document")
          .argument("<collection>", "Collection name")
          .requiredOption("--content <text>", "Content")
          .option("--domain <domain>", "Domain", "general")
          .option("--title <title>", "Title (guidelines)")
          .option("--name <name>", "Name (seeds, skills)")
          .option("--description <desc>", "Description")
          .option("--type <type>", "Config type")
          .option("--category <cat>", "Category (memories)")
          .option("--tags <tags>", "Comma-separated tags")
          .option("--priority <n>", "Priority (guidelines)")
          .option("--triggers <triggers>", "Comma-separated triggers (skills)")
          .action(async (collection: string, opts: Record<string, string>) => {
            const colName = resolveCollectionName(collection);
            const col = await db.getCollection(colName);
            const parsedTags = opts.tags
              ? opts.tags.split(",").map((t: string) => t.trim())
              : undefined;
            const parsedTriggers = opts.triggers
              ? opts.triggers.split(",").map((t: string) => t.trim())
              : undefined;

            switch (colName) {
              case "memories": {
                const result = await memories.store(col, {
                  content: opts.content,
                  domain: opts.domain ?? "general",
                  category: opts.category,
                  tags: parsedTags,
                  summary: opts.description,
                });
                console.log(JSON.stringify({ action: result.action }, null, 2));
                break;
              }
              case "guidelines": {
                const result = await guidelines.store(col, {
                  title: opts.title ?? opts.name ?? "Untitled",
                  content: opts.content,
                  domain: opts.domain ?? "general",
                  tags: parsedTags,
                  priority: opts.priority ? parseInt(opts.priority) : undefined,
                });
                console.log(JSON.stringify({ action: result.action }, null, 2));
                break;
              }
              case "seeds": {
                const result = await seeds.store(col, {
                  name: opts.name ?? "unnamed",
                  description: opts.description ?? "",
                  content: opts.content,
                  domain: opts.domain ?? "general",
                  tags: parsedTags,
                });
                console.log(JSON.stringify({ action: result.action }, null, 2));
                break;
              }
              case "agent_config": {
                if (!opts.type) {
                  console.error(`--type required. Valid: ${agentConfig.VALID_TYPES.join(", ")}`);
                  return;
                }
                const result = await agentConfig.store(col, {
                  type: opts.type as agentConfig.AgentConfigType,
                  agentId: cfg.agentId,
                  content: opts.content,
                });
                console.log(JSON.stringify({ action: result.action, type: opts.type }, null, 2));
                break;
              }
              case "skills": {
                const result = await skills.store(col, {
                  name: opts.name ?? "unnamed",
                  description: opts.description ?? "",
                  promptBase: opts.content,
                  triggers: parsedTriggers,
                });
                console.log(JSON.stringify({ action: result.action }, null, 2));
                break;
              }
            }
          });

        cmd
          .command("get-config")
          .description("Load agent configuration")
          .option("--type <type>", "Specific config type")
          .option("--agent-id <id>", "Agent ID")
          .action(async (opts: { type?: string; agentId?: string }) => {
            const col = await db.getCollection("agent_config");
            const docs = await agentConfig.getConfig(col, opts.agentId ?? cfg.agentId, opts.type);
            console.log(JSON.stringify(docs, jsonReplacer, 2));
          });

        cmd
          .command("get-skill")
          .description("Get a skill by name")
          .requiredOption("--name <name>", "Skill name")
          .action(async (opts: { name: string }) => {
            const col = await db.getCollection("skills");
            const doc = await skills.getSkill(col, opts.name);
            if (!doc) {
              console.error(`Skill "${opts.name}" not found.`);
              return;
            }
            console.log(JSON.stringify(doc, jsonReplacer, 2));
          });

        cmd
          .command("match-skill")
          .description("Find skills by trigger")
          .requiredOption("--trigger <trigger>", "Trigger keyword")
          .action(async (opts: { trigger: string }) => {
            const col = await db.getCollection("skills");
            const matches = await skills.matchByTrigger(col, opts.trigger);
            console.log(JSON.stringify(matches, jsonReplacer, 2));
          });

        const migrateCmd = cmd
          .command("migrate")
          .description("Migration from workspace files to MongoDB");

        migrateCmd
          .command("scan")
          .description("Dry-run: show what would be migrated")
          .option("--workspace <path>", "Workspace path")
          .action(async (opts: { workspace?: string }) => {
            const migrator = createMigrator(db, cfg.agentId);
            const report = await migrator.scan(opts.workspace);
            console.log(JSON.stringify(report, null, 2));
          });

        migrateCmd
          .command("all")
          .description("Run all migrations")
          .option("--workspace <path>", "Workspace path")
          .option("--domain <domain>", "Domain for memories")
          .action(async (opts: { workspace?: string; domain?: string }) => {
            const migrator = createMigrator(db, cfg.agentId);
            const results = await migrator.migrateAll(opts.workspace, opts.domain);
            console.log(JSON.stringify(results, null, 2));
          });

        migrateCmd
          .command("workspace-files")
          .description("Migrate workspace files to agent_config")
          .option("--workspace <path>", "Workspace path")
          .action(async (opts: { workspace?: string }) => {
            const migrator = createMigrator(db, cfg.agentId);
            const result = await migrator.migrateWorkspaceFiles(opts.workspace);
            console.log(JSON.stringify(result, null, 2));
          });

        migrateCmd
          .command("knowledge")
          .description("Migrate knowledge/ to seeds")
          .option("--workspace <path>", "Workspace path")
          .action(async (opts: { workspace?: string }) => {
            const migrator = createMigrator(db, cfg.agentId);
            const result = await migrator.migrateKnowledge(opts.workspace);
            console.log(JSON.stringify(result, null, 2));
          });

        migrateCmd
          .command("memory-md")
          .description("Migrate MEMORY.md to memories")
          .option("--workspace <path>", "Workspace path")
          .option("--domain <domain>", "Domain", "openclaw-memory")
          .action(async (opts: { workspace?: string; domain?: string }) => {
            const migrator = createMigrator(db, cfg.agentId);
            const result = await migrator.migrateMemoryMd(opts.workspace, opts.domain);
            console.log(JSON.stringify(result, null, 2));
          });

        migrateCmd
          .command("daily-logs")
          .description("Migrate memory/ daily logs to memories")
          .option("--workspace <path>", "Workspace path")
          .option("--domain <domain>", "Domain", "openclaw-daily")
          .action(async (opts: { workspace?: string; domain?: string }) => {
            const migrator = createMigrator(db, cfg.agentId);
            const result = await migrator.migrateDailyLogs(opts.workspace, opts.domain);
            console.log(JSON.stringify(result, null, 2));
          });

        migrateCmd
          .command("seed-starters")
          .description("Insert starter seeds and skill-builder skill")
          .action(async () => {
            const migrator = createMigrator(db, cfg.agentId);
            const result = await migrator.seedStarters();
            console.log(JSON.stringify(result, null, 2));
          });

        cmd
          .command("export")
          .description("Export a collection to JSON")
          .argument("<collection>", "Collection name")
          .option("--domain <domain>", "Filter by domain")
          .option("--name <name>", "Filter by name (skills)")
          .option("--agent-id <id>", "Agent ID (config)")
          .action(
            async (
              collection: string,
              opts: { domain?: string; name?: string; agentId?: string },
            ) => {
              const colName = resolveCollectionName(collection);
              const col = await db.getCollection(colName);

              let docs: Record<string, unknown>[];
              switch (colName) {
                case "seeds":
                  docs = (await seeds.exportAll(col, opts.domain)) as unknown as Record<
                    string,
                    unknown
                  >[];
                  break;
                case "skills":
                  docs = (await skills.exportAll(col, opts.name)) as unknown as Record<
                    string,
                    unknown
                  >[];
                  break;
                case "agent_config":
                  docs = (await agentConfig.exportConfig(
                    col,
                    opts.agentId ?? cfg.agentId,
                  )) as unknown as Record<string, unknown>[];
                  break;
                default:
                  docs = (await col
                    .find(opts.domain ? { domain: opts.domain } : {})
                    .toArray()) as unknown as Record<string, unknown>[];
              }
              console.log(JSON.stringify(docs, jsonReplacer, 2));
            },
          );

        cmd
          .command("prune")
          .description("Delete expired memories")
          .action(async () => {
            const col = await db.getCollection("memories");
            const deleted = await memories.prune(col);
            console.log(JSON.stringify({ deleted }, null, 2));
          });

        // ====================================================================
        // Routing Subcommands
        // ====================================================================

        const routingCmd = cmd.command("routing").description("Dynamic model routing management");

        routingCmd
          .command("status")
          .description("Show routing context status")
          .option("--agent-id <id>", "Agent ID")
          .action(async (opts: { agentId?: string }) => {
            const col = await db.getCollection("routing");
            const doc = await getRoutingContext(col, opts.agentId ?? cfg.agentId);
            if (!doc) {
              console.log(
                JSON.stringify(
                  { status: "not_initialized", agentId: opts.agentId ?? cfg.agentId },
                  null,
                  2,
                ),
              );
              return;
            }
            const activeModels = doc.models.filter((m) => m.active !== false);
            const byTier: Record<string, string[]> = {};
            for (const m of activeModels) {
              (byTier[m.tier] ??= []).push(m.id);
            }
            console.log(
              JSON.stringify(
                {
                  status: "active",
                  agentId: doc.agent_id,
                  version: doc.version,
                  modelsHash: doc.models_hash,
                  totalModels: doc.models.length,
                  activeModels: activeModels.length,
                  modelsByTier: byTier,
                  rulesCount: doc.routing.rules.length,
                  categories: Object.keys(doc.classification.categories),
                  defaultTier: doc.routing.default_tier,
                  updatedAt: doc.updated_at,
                },
                null,
                2,
              ),
            );
          });

        routingCmd
          .command("models")
          .description("List discovered models with tier and capabilities")
          .option("--agent-id <id>", "Agent ID")
          .action(async (opts: { agentId?: string }) => {
            const col = await db.getCollection("routing");
            const doc = await getRoutingContext(col, opts.agentId ?? cfg.agentId);
            if (!doc) {
              console.error("Routing not initialized. Enable routing and restart the gateway.");
              return;
            }
            const models = doc.models.map((m) => ({
              id: m.id,
              alias: m.alias,
              tier: m.tier,
              active: m.active !== false,
              tools: m.capabilities.tools,
              reasoning: m.capabilities.reasoning,
              use_when: m.use_when.length > 0 ? m.use_when : undefined,
              never_when: m.never_when.length > 0 ? m.never_when : undefined,
            }));
            console.log(JSON.stringify(models, null, 2));
          });

        routingCmd
          .command("rules")
          .description("Show active routing rules")
          .option("--agent-id <id>", "Agent ID")
          .action(async (opts: { agentId?: string }) => {
            const col = await db.getCollection("routing");
            const doc = await getRoutingContext(col, opts.agentId ?? cfg.agentId);
            if (!doc) {
              console.error("Routing not initialized.");
              return;
            }
            console.log(
              JSON.stringify(
                {
                  defaultTier: doc.routing.default_tier,
                  ambiguousAction: doc.routing.ambiguous_action,
                  rules: doc.routing.rules,
                  escalation: doc.escalation,
                },
                null,
                2,
              ),
            );
          });

        routingCmd
          .command("set-tier")
          .description("Change the tier of a model")
          .requiredOption("--model <id>", "Model ID (e.g., google/gemini-3-pro)")
          .requiredOption("--tier <tier>", "New tier (fast/mid/heavy)")
          .option("--agent-id <id>", "Agent ID")
          .action(async (opts: { model: string; tier: string; agentId?: string }) => {
            const validTiers = ["fast", "mid", "heavy"];
            if (!validTiers.includes(opts.tier)) {
              console.error(`Invalid tier "${opts.tier}". Valid: ${validTiers.join(", ")}`);
              return;
            }
            const col = await db.getCollection("routing");
            const doc = await getRoutingContext(col, opts.agentId ?? cfg.agentId);
            if (!doc) {
              console.error("Routing not initialized.");
              return;
            }
            const model = doc.models.find((m) => m.id === opts.model);
            if (!model) {
              console.error(
                `Model "${opts.model}" not found. Available: ${doc.models.map((m) => m.id).join(", ")}`,
              );
              return;
            }
            const oldTier = model.tier;
            model.tier = opts.tier as "fast" | "mid" | "heavy";
            await storeRoutingContext(col, doc);
            routingCache.invalidate(opts.agentId ?? cfg.agentId);
            console.log(
              JSON.stringify({ model: opts.model, oldTier, newTier: opts.tier }, null, 2),
            );
          });

        routingCmd
          .command("rediscover")
          .description("Force re-discovery of models from config")
          .option("--agent-id <id>", "Agent ID")
          .action(async (opts: { agentId?: string }) => {
            const agentId = opts.agentId ?? cfg.agentId;
            const col = await db.getCollection("routing");
            const existing = await getRoutingContext(col, agentId);

            const seedUrl = new URL("../docs/db-snapshot/routing--default.json", import.meta.url);
            const seedRaw = await fs.readFile(seedUrl, "utf-8");
            const seed = JSON.parse(seedRaw);
            const heuristics = seed.model_discovery?.tier_heuristics ?? {};

            const discovered = discoverModels(api.config, agentId, heuristics);
            const newHash = computeModelsHash(discovered);

            if (!existing) {
              await storeRoutingContext(col, {
                agent_id: agentId,
                version: seed.version ?? 5,
                models: discovered,
                models_hash: newHash,
                model_discovery: seed.model_discovery,
                classification: seed.classification,
                routing: seed.routing,
                escalation: seed.escalation,
              });
              console.log(
                JSON.stringify(
                  {
                    action: "initialized",
                    modelsDiscovered: discovered.length,
                    models: discovered.map((m) => ({ id: m.id, tier: m.tier })),
                  },
                  null,
                  2,
                ),
              );
            } else {
              const merged = mergeModelsIncremental(existing.models, discovered);
              await storeRoutingContext(col, { ...existing, models: merged, models_hash: newHash });
              routingCache.invalidate(agentId);
              const added = discovered.filter((d) => !existing.models.some((e) => e.id === d.id));
              const removed = existing.models.filter((e) => !discovered.some((d) => d.id === e.id));
              console.log(
                JSON.stringify(
                  {
                    action: "rediscovered",
                    added: added.map((m) => ({ id: m.id, tier: m.tier })),
                    removed: removed.map((m) => m.id),
                    totalActive: merged.filter((m) => m.active !== false).length,
                  },
                  null,
                  2,
                ),
              );
            }
          });

        routingCmd
          .command("test")
          .description("Test classification of a prompt (dry-run, no override emitted)")
          .requiredOption("--prompt <text>", "Prompt text to classify")
          .option("--tools", "Simulate tools-in-context", false)
          .option("--agent-id <id>", "Agent ID")
          .action(async (opts: { prompt: string; tools: boolean; agentId?: string }) => {
            const col = await db.getCollection("routing");
            const doc = await getRoutingContext(col, opts.agentId ?? cfg.agentId);
            if (!doc) {
              console.error("Routing not initialized.");
              return;
            }
            const decision = resolveRoutingOverride(
              opts.prompt,
              doc,
              opts.tools,
              undefined,
              opts.agentId ?? cfg.agentId,
            );
            console.log(JSON.stringify(decision, null, 2));
          });

        routingCmd
          .command("reset")
          .description("Delete routing context and re-seed from defaults")
          .option("--agent-id <id>", "Agent ID")
          .action(async (opts: { agentId?: string }) => {
            const agentId = opts.agentId ?? cfg.agentId;
            const col = await db.getCollection("routing");
            const result = await col.deleteOne({ agent_id: agentId });
            routingCache.invalidate(agentId);
            console.log(
              JSON.stringify(
                {
                  action: "deleted",
                  agentId,
                  deleted: result.deletedCount > 0,
                  note: "Restart gateway to re-seed with defaults",
                },
                null,
                2,
              ),
            );
          });

        routingCmd
          .command("health")
          .description("Show circuit breaker health status for all models")
          .action(() => {
            const snapshot = healthTracker.snapshot();
            if (Object.keys(snapshot).length === 0) {
              console.log(
                JSON.stringify(
                  { status: "no_data", message: "No health events recorded yet" },
                  null,
                  2,
                ),
              );
              return;
            }
            console.log(JSON.stringify(snapshot, null, 2));
          });

        routingCmd
          .command("reset-health")
          .description("Reset circuit breaker state")
          .option("--model <id>", "Reset a specific model (otherwise resets all)")
          .action((opts: { model?: string }) => {
            if (opts.model) {
              healthTracker.resetModel(opts.model);
              console.log(JSON.stringify({ action: "reset", model: opts.model }, null, 2));
            } else {
              healthTracker.resetAll();
              console.log(JSON.stringify({ action: "reset_all" }, null, 2));
            }
          });
      },
      { commands: ["mongobrain"] },
    );

    // ========================================================================
    // Lifecycle Hooks
    // ========================================================================

    // Inject agent_config (soul, instructions, persona, etc.) from MongoDB
    // When dbFirst is enabled, bootstrap hook already injects config into workspace files
    api.on(
      "before_agent_start",
      async () => {
        if (cfg.dbFirst) return;
        try {
          const col = await db.getCollection("agent_config");
          const docs = await agentConfig.getConfig(col, cfg.agentId);
          if (docs.length === 0) return;

          const configContext = docs.map((d) => `### ${d.type}\n${d.content}`).join("\n\n");

          api.logger.info?.(
            `memory-mongodb: injecting agent_config (${docs.length} sections) into context`,
          );

          return {
            prependContext: `<agent-config>\n${configContext}\n</agent-config>`,
          };
        } catch (err) {
          api.logger.warn(`memory-mongodb: agent_config injection failed: ${String(err)}`);
        }
      },
      { priority: 10 },
    );

    if (cfg.autoRecall) {
      api.on("before_agent_start", async (event) => {
        if (!event.prompt || event.prompt.length < 5) return;

        try {
          const col = await db.getCollection("memories");
          const results = await memories.search(col, {
            query: event.prompt,
            limit: 3,
          });

          if (results.length === 0) return;

          const memoryContext = results
            .map(
              (r) =>
                `- [${(r as Record<string, unknown>).category}] ${(r as Record<string, unknown>).content}`,
            )
            .join("\n");

          api.logger.info?.(`memory-mongodb: injecting ${results.length} memories into context`);

          return {
            prependContext: `<relevant-memories>\nThe following memories may be relevant:\n${memoryContext}\n</relevant-memories>`,
          };
        } catch (err) {
          api.logger.warn(`memory-mongodb: recall failed: ${String(err)}`);
        }
      });
    }

    if (cfg.autoCapture) {
      api.on("agent_end", async (event) => {
        if (!event.success || !event.messages || event.messages.length === 0) return;

        try {
          const texts: string[] = [];
          for (const msg of event.messages) {
            if (!msg || typeof msg !== "object") continue;
            const msgObj = msg as Record<string, unknown>;
            if (msgObj.role !== "user" && msgObj.role !== "assistant") continue;

            const content = msgObj.content;
            if (typeof content === "string") {
              texts.push(content);
            } else if (Array.isArray(content)) {
              for (const block of content) {
                if (
                  block &&
                  typeof block === "object" &&
                  "type" in block &&
                  (block as Record<string, unknown>).type === "text" &&
                  "text" in block &&
                  typeof (block as Record<string, unknown>).text === "string"
                ) {
                  texts.push((block as Record<string, unknown>).text as string);
                }
              }
            }
          }

          const toCapture = texts.filter(shouldCapture);
          if (toCapture.length === 0) return;

          const col = await db.getCollection("memories");
          let stored = 0;
          for (const text of toCapture.slice(0, 3)) {
            const category = detectCategory(text);
            const result = await memories.store(col, {
              content: text,
              domain: "auto-capture",
              category,
              source: "auto-capture",
              confidence: 0.7,
            });
            if (result.action === "created") stored++;
          }

          if (stored > 0) {
            api.logger.info(`memory-mongodb: auto-captured ${stored} memories`);
          }
        } catch (err) {
          api.logger.warn(`memory-mongodb: capture failed: ${String(err)}`);
        }
      });
    }

    // ========================================================================
    // DB-First Bootstrap (agent:bootstrap hook + skill injection)
    // ========================================================================

    registerBootstrapHook(api, db, cfg);

    // ========================================================================
    // Dynamic Model Routing
    // ========================================================================

    const routingCache = new RoutingCache(cfg.routing.cacheTtlMs);
    const healthTracker = new ProviderHealthTracker(cfg.routing.circuitBreaker);

    if (cfg.routing.enabled) {
      // Per-message routing override
      api.on(
        "before_agent_start",
        async (event, ctx) => {
          if (!event.prompt || event.prompt.length < 3) return;

          try {
            const col = await db.getCollection("routing");
            const routingDoc = await routingCache.get(col, cfg.agentId);
            if (!routingDoc || routingDoc.models.length === 0) return;

            // Detect if tools are active in this agent context
            const toolsInContext = !!(ctx as Record<string, unknown>).messageProvider;

            const decision = resolveRoutingOverride(
              event.prompt,
              routingDoc,
              toolsInContext,
              api.logger,
              cfg.agentId,
              healthTracker.isHealthy.bind(healthTracker),
            );

            if (decision.override) {
              const sessionKey = (ctx as Record<string, unknown>).sessionKey as string | undefined;
              if (sessionKey) {
                healthTracker.recordDecision(sessionKey, `${decision.provider}/${decision.model}`);
              }
              return {
                modelOverride: {
                  provider: decision.provider,
                  model: decision.model,
                  reason: decision.reason,
                },
              };
            }
          } catch (err) {
            api.logger.warn(`memory-mongodb: routing failed: ${String(err)}`);
          }
        },
        { priority: 5 },
      );

      // Record outcome for circuit breaker
      api.on("agent_end", async (event, ctx) => {
        const sessionKey = (ctx as Record<string, unknown>).sessionKey as string | undefined;
        if (!sessionKey) return;
        const ev = event as Record<string, unknown>;
        healthTracker.recordOutcome(
          sessionKey,
          ev.success === true,
          typeof ev.error === "string" ? ev.error : undefined,
        );
        if (ev.success === false && typeof ev.error === "string") {
          api.logger.warn(
            `memory-mongodb: agent run failed: ${(ev.error as string).slice(0, 200)}`,
          );
        }
      });
    }

    // ========================================================================
    // Service
    // ========================================================================

    api.registerService({
      id: "memory-mongodb",
      start: async () => {
        api.logger.info(
          `memory-mongodb: initialized (uri: ${cfg.uri.replace(/\/\/[^@]*@/, "//***@")}, db: ${cfg.database})`,
        );

        // CLI Workspace Bootstrap (TOOLS.md + BOOT.md)
        try {
          if (hasAnyCliModel(api.config)) {
            const workspaceDirs = resolveWorkspaceDirs(api.config);
            for (const wsDir of workspaceDirs) {
              await ensureMongobrainWorkspaceFiles(wsDir, api.logger);
            }
          }
        } catch (err) {
          api.logger.warn(`memory-mongodb: workspace bootstrap failed: ${String(err)}`);
        }

        // Routing seed (discover models, store routing context)
        if (cfg.routing.enabled) {
          try {
            const col = await db.getCollection("routing");
            const existing = await getRoutingContext(col, cfg.agentId);

            const seedUrl = new URL("../docs/db-snapshot/routing--default.json", import.meta.url);
            const seedRaw = await fs.readFile(seedUrl, "utf-8");
            const seed = JSON.parse(seedRaw);

            const heuristics = seed.model_discovery?.tier_heuristics ?? {};
            const discovered = discoverModels(api.config, cfg.agentId, heuristics);
            const newHash = computeModelsHash(discovered);

            if (!existing) {
              await storeRoutingContext(col, {
                agent_id: cfg.agentId,
                version: seed.version ?? 5,
                models: discovered,
                models_hash: newHash,
                model_discovery: seed.model_discovery,
                classification: seed.classification,
                routing: seed.routing,
                escalation: seed.escalation,
              });
              api.logger.info(
                `memory-mongodb: routing_context initialized (${discovered.length} models discovered)`,
              );
            } else if (existing.models_hash !== newHash) {
              const merged = mergeModelsIncremental(existing.models, discovered);
              await storeRoutingContext(col, {
                ...existing,
                models: merged,
                models_hash: newHash,
              });
              routingCache.invalidate(cfg.agentId);
              const added = merged.length - existing.models.length;
              api.logger.info(
                `memory-mongodb: routing re-discovery (${added >= 0 ? "added" : "removed"} ${Math.abs(added)} models)`,
              );
            }
          } catch (err) {
            api.logger.warn(`memory-mongodb: routing seed failed: ${String(err)}`);
          }
        }

        // Auto-seed: populate seeds, skills, agent_config on first boot (empty collections)
        try {
          const migrator = createMigrator(db, cfg.agentId);
          const seedsCol = await db.getCollection("seeds");
          const skillsCol = await db.getCollection("skills");
          const configCol = await db.getCollection("agent_config");

          const seedsCount = await seedsCol.countDocuments();
          const skillsCount = await skillsCol.countDocuments();
          const configCount = await configCol.countDocuments();

          if (seedsCount === 0 || skillsCount === 0) {
            try {
              api.logger.info(
                `memory-mongodb: seeds=${seedsCount} skills=${skillsCount}, running seedStarters...`,
              );
              const result = await migrator.seedStarters();
              api.logger.info(
                `memory-mongodb: seedStarters done — seeds inserted=${result.seeds.inserted} skipped=${result.seeds.skipped}, skills inserted=${result.skills.inserted} skipped=${result.skills.skipped}`,
              );
            } catch (err) {
              api.logger.warn(`memory-mongodb: seedStarters failed: ${String(err)}`);
            }
          }

          // Seed claude-code-ops skill from db-snapshot if missing
          if (!(await skillsCol.findOne({ name: "claude-code-ops" }))) {
            try {
              const opsUrl = new URL(
                "../docs/db-snapshot/skill--claude-code-ops.json",
                import.meta.url,
              );
              const opsRaw = await fs.readFile(opsUrl, "utf-8");
              const opsSkill = JSON.parse(opsRaw);
              const now = new Date();
              await skillsCol.insertOne({ ...opsSkill, created_at: now, updated_at: now });
              api.logger.info("memory-mongodb: auto-seeded skill 'claude-code-ops'");
            } catch (err) {
              api.logger.warn(`memory-mongodb: claude-code-ops seed failed: ${String(err)}`);
            }
          }

          // Auto-seed agent_config from embedded defaults (DB-first, no disk dependency)
          if (configCount === 0) {
            const now = new Date();
            let seeded = 0;
            for (const def of AGENT_CONFIG_DEFAULTS) {
              const filter = { type: def.type, agent_id: cfg.agentId };
              const existing = await configCol.findOne(filter);
              if (!existing) {
                await configCol.insertOne({
                  type: def.type,
                  agent_id: cfg.agentId,
                  content: def.content,
                  version: 1,
                  created_at: now,
                  updated_at: now,
                });
                seeded++;
              }
            }
            if (seeded > 0) {
              api.logger.info(
                `memory-mongodb: auto-seeded ${seeded} agent_config entries from embedded defaults`,
              );
            }
          }
        } catch (err) {
          api.logger.warn(`memory-mongodb: auto-seed failed: ${String(err)}`);
        }
      },
      stop: async () => {
        await db.close();
        api.logger.info("memory-mongodb: connection closed");
      },
    });
  },
};

// ============================================================================
// Helpers
// ============================================================================

function formatResults(results: Record<string, unknown>[]): string {
  return results
    .map((r, i) => {
      const name = r.name ?? r.title ?? r.type ?? "";
      const content = (r.content as string) ?? "";
      const preview = content.slice(0, 120) + (content.length > 120 ? "..." : "");
      const score = r.score != null ? ` (score: ${Number(r.score).toFixed(2)})` : "";
      return `${i + 1}. **${name}**${score}\n   ${preview}`;
    })
    .join("\n");
}

function formatDoc(doc: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(doc)) {
    if (key === "_id") continue;
    if (typeof value === "string" && value.length > 200) {
      lines.push(`**${key}**: ${value.slice(0, 200)}...`);
    } else {
      lines.push(`**${key}**: ${JSON.stringify(value)}`);
    }
  }
  return lines.join("\n");
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (value && typeof value === "object" && "toHexString" in value) {
    return String(value);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return value;
}

// ============================================================================
// CLI Workspace Helpers
// ============================================================================

const MONGOBRAIN_MARKER = "<!-- mongobrain:native -->";

function extractProvider(modelRef: string): string | null {
  const slash = modelRef.indexOf("/");
  return slash > 0 ? modelRef.slice(0, slash).trim().toLowerCase() : null;
}

function hasAnyCliModel(config: Record<string, unknown>): boolean {
  const agents = config.agents as Record<string, unknown> | undefined;
  const defaults = agents?.defaults as Record<string, unknown> | undefined;
  const cliBackends = (defaults?.cliBackends ?? {}) as Record<string, unknown>;
  const cliIds = new Set([
    "claude-cli",
    "codex-cli",
    ...Object.keys(cliBackends).map((k) => k.toLowerCase()),
  ]);

  const checkModel = (model: unknown): boolean => {
    const raw =
      typeof model === "string" ? model : (model as Record<string, unknown> | undefined)?.primary;
    if (typeof raw !== "string") return false;
    const provider = extractProvider(raw);
    return provider != null && cliIds.has(provider);
  };

  if (checkModel(defaults?.model)) return true;

  const fallbacks = (defaults?.model as Record<string, unknown> | undefined)?.fallbacks;
  if (Array.isArray(fallbacks) && fallbacks.some(checkModel)) return true;

  const list = (agents?.list ?? []) as Array<Record<string, unknown>>;
  return list.some((a) => checkModel(a.model));
}

function resolveWorkspaceDirs(config: Record<string, unknown>): string[] {
  const agents = config.agents as Record<string, unknown> | undefined;
  const defaults = agents?.defaults as Record<string, unknown> | undefined;
  const defaultWs = (defaults?.workspace as string) ?? "~/.openclaw/workspace";
  const dirs = new Set<string>([resolveTilde(defaultWs)]);

  const list = (agents?.list ?? []) as Array<Record<string, unknown>>;
  for (const agent of list) {
    if (typeof agent.workspace === "string" && agent.workspace.trim()) {
      dirs.add(resolveTilde(agent.workspace));
    }
  }

  return Array.from(dirs);
}

function resolveTilde(p: string): string {
  if (p.startsWith("~/")) {
    return path.join(process.env.HOME ?? "/root", p.slice(2));
  }
  return p;
}

async function ensureMongobrainWorkspaceFiles(
  wsDir: string,
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
): Promise<void> {
  try {
    await fs.access(wsDir);
  } catch {
    return;
  }

  await ensureSection(path.join(wsDir, "TOOLS.md"), MONGOBRAIN_TOOLS, logger);
  await ensureSection(path.join(wsDir, "BOOT.md"), MONGOBRAIN_BOOT, logger);
}

async function ensureSection(
  filePath: string,
  section: string,
  logger: { info: (msg: string) => void },
): Promise<void> {
  let existing = "";
  try {
    existing = await fs.readFile(filePath, "utf-8");
  } catch {
    // file doesn't exist yet
  }

  if (existing.includes(MONGOBRAIN_MARKER)) return;

  const updated = existing.length > 0 ? `${existing.trimEnd()}\n\n${section}\n` : `${section}\n`;
  await fs.writeFile(filePath, updated, "utf-8");
  logger.info(`memory-mongodb: wrote mongoBrain section to ${path.basename(filePath)}`);
}

const MONGOBRAIN_TOOLS = `${MONGOBRAIN_MARKER}
## MongoBrain (MongoDB Memory Plugin)

Persistent MongoDB knowledge base accessible via CLI.
Use \`openclaw mongobrain\` commands through exec/bash.

### Commands

| Command | Usage |
|---------|-------|
| **search** | \`openclaw mongobrain search "query" [--collection name] [--domain dom] [--limit n]\` |
| **store** | \`openclaw mongobrain store <collection> --content "text" [--name n] [--domain d] [--tags a,b]\` |
| **get-config** | \`openclaw mongobrain get-config [--type soul\\|identity\\|...]\` |
| **get-skill** | \`openclaw mongobrain get-skill --name "name"\` |
| **match-skill** | \`openclaw mongobrain match-skill --trigger "keyword"\` |
| **status** | \`openclaw mongobrain status\` |
| **export** | \`openclaw mongobrain export <collection> [--domain d]\` |

### Collections

- **memories**: Facts, preferences, decisions, entities
- **guidelines**: Behavioral rules with priority
- **seeds**: Reusable knowledge templates
- **config**: Agent configuration (soul, identity, instructions, context, tools, safety, persona, rules)
- **skills**: Skill definitions with triggers

### Examples

\`\`\`bash
openclaw mongobrain search "user preferences"
openclaw mongobrain store memories --content "User prefers dark mode" --category preference
openclaw mongobrain get-config --type soul
openclaw mongobrain match-skill --trigger "translate"
\`\`\`
<!-- /mongobrain:native -->`;

const MONGOBRAIN_BOOT = `${MONGOBRAIN_MARKER}
## MongoBrain Startup Check

\`\`\`bash
openclaw mongobrain status
\`\`\`
<!-- /mongobrain:native -->`;

// ============================================================================
// Embedded agent_config defaults (DB-first: no disk dependency)
// ============================================================================

const AGENT_CONFIG_DEFAULTS: Array<{ type: string; content: string }> = [
  {
    type: "soul",
    content: [
      "You are an intelligent AI assistant powered by OpenClaw with persistent MongoDB memory (mongoBrain).",
      "",
      "## Core Behavior",
      "- Be helpful, precise, and concise",
      "- Use mongoBrain to store and recall knowledge across conversations",
      "- Before answering, check if relevant memories exist: use mongobrain_search or `openclaw mongobrain search`",
      "- After learning something important (preferences, decisions, facts), store it: use mongobrain_store or `openclaw mongobrain store`",
      "- Adapt your language to the user (respond in the same language they use)",
      "",
      "## Memory Usage",
      "- Preferences, decisions, and facts should be stored in the `memories` collection",
      "- Behavioral rules and SOPs go in `guidelines`",
      "- Reusable knowledge templates go in `seeds`",
      "- Search before storing to avoid duplicates",
      "",
      "## Communication Style",
      "- Be direct: answer first, explain after if needed",
      "- Use structured formatting (lists, headers) for complex responses",
      "- Ask clarifying questions when the request is ambiguous",
      "- Acknowledge when you don't know something",
    ].join("\n"),
  },
  {
    type: "boot",
    content: [
      "## mongoBrain — Identity Recovery",
      "",
      "All'avvio, carica la configurazione completa dal database usando `mongobrain_config_load`.",
      "",
      "Applica ogni sezione (soul, identity, user, tools, agents, heartbeat) come contesto operativo.",
      "",
      "Poi carica l'indice delle skill attive:",
      "- Usa `mongobrain_search` con collection `skills` per trovare skill attive",
      "- Usa `mongobrain_skill_match` per attivare skill specifiche in base al contesto",
      "",
      "Se una sezione non e' presente nel database, ignorala e prosegui.",
      "",
      "### Creare nuove skill",
      "",
      "Per creare una nuova skill, usa `mongobrain_skill_match` con trigger `create skill`.",
      "Poi carica la skill-builder con `mongobrain_get` collection `skills` name `skill-builder`.",
      "Segui le guidelines della skill-builder per compilare ogni sezione del documento.",
    ].join("\n"),
  },
  {
    type: "tools",
    content: [
      "## mongoBrain (MongoDB Memory Plugin)",
      "",
      "Persistent knowledge base. Use `openclaw mongobrain` CLI or native tools.",
      "",
      "### Native Tools (API agents)",
      "| Tool | Usage |",
      "|------|-------|",
      "| `mongobrain_search` | Search across collections with text ranking |",
      "| `mongobrain_store` | Store a document in any collection |",
      "| `mongobrain_get` | Get a specific document by name/type |",
      "| `mongobrain_forget` | Delete or deactivate a document |",
      "| `mongobrain_skill_match` | Find skills matching a trigger |",
      "| `mongobrain_config_load` | Load all agent config sections |",
      "",
      "### CLI Commands (exec/bash)",
      "| Command | Usage |",
      "|---------|-------|",
      '| **search** | `openclaw mongobrain search "query" [--collection name] [--limit n]` |',
      '| **store** | `openclaw mongobrain store <collection> --content "text" [--name n] [--tags a,b]` |',
      "| **get-config** | `openclaw mongobrain get-config [--type soul]` |",
      '| **match-skill** | `openclaw mongobrain match-skill --trigger "keyword"` |',
      "| **status** | `openclaw mongobrain status` |",
      "| **export** | `openclaw mongobrain export <collection>` |",
      "",
      "### Collections",
      "- **memories**: Facts, preferences, decisions, entities",
      "- **guidelines**: Behavioral rules with priority and domain",
      "- **seeds**: Reusable knowledge templates",
      "- **config**: Agent configuration (soul, identity, tools, boot, etc.)",
      "- **skills**: Skill definitions with triggers and guidelines",
      "- **routing**: Model routing context (tiers, rules, classification)",
    ].join("\n"),
  },
  {
    type: "identity",
    content: [
      "name: OpenClaw Agent",
      "description: AI assistant with persistent MongoDB memory",
      "version: 1",
    ].join("\n"),
  },
];

export default memoryMongoDBPlugin;
