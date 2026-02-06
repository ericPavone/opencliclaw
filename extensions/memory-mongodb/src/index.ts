import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import { stringEnum } from "openclaw/plugin-sdk";
import * as agentConfig from "./collections/agent-config.js";
import * as guidelines from "./collections/guidelines.js";
import * as memories from "./collections/memories.js";
import * as seeds from "./collections/seeds.js";
import * as skills from "./collections/skills.js";
import { mongodbConfigSchema } from "./config.js";
import { MongoMemoryDB, ALL_COLLECTIONS, type CollectionName } from "./db.js";
import { createMigrator } from "./migrate.js";

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
  if (/prefer|like|love|hate|want/i.test(lower)) return "preference";
  if (/decided|will use|budeme/i.test(lower)) return "decision";
  if (/\+\d{10,}|@[\w.-]+\.\w+|is called/i.test(lower)) return "entity";
  if (/\bis\b|\bare\b|\bhas\b|\bhave\b/i.test(lower)) return "fact";
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
      },
      { commands: ["mongobrain"] },
    );

    // ========================================================================
    // Lifecycle Hooks
    // ========================================================================

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
    // Service
    // ========================================================================

    api.registerService({
      id: "memory-mongodb",
      start: () => {
        api.logger.info(
          `memory-mongodb: initialized (uri: ${cfg.uri.replace(/\/\/[^@]*@/, "//***@")}, db: ${cfg.database})`,
        );
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

export default memoryMongoDBPlugin;
