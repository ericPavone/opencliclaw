import { type Collection, type Db, type Document, MongoClient } from "mongodb";
import type { MongoDBConfig, TlsConfig } from "./config.js";

export type CollectionName =
  | "memories"
  | "guidelines"
  | "seeds"
  | "agent_config"
  | "skills"
  | "routing";

export const ALL_COLLECTIONS: CollectionName[] = [
  "memories",
  "guidelines",
  "seeds",
  "agent_config",
  "skills",
  "routing",
];

function buildClientOptions(tls?: TlsConfig): Record<string, unknown> {
  const opts: Record<string, unknown> = {};
  if (!tls) return opts;

  if (tls.caFile) {
    opts.tls = true;
    opts.tlsCAFile = tls.caFile;
  }
  if (tls.certKeyFile) {
    opts.tls = true;
    opts.tlsCertificateKeyFile = tls.certKeyFile;
  }
  if (tls.allowInvalidCerts) {
    opts.tls = true;
    opts.tlsAllowInvalidCertificates = true;
  }
  return opts;
}

async function safeCreateTextIndex(
  col: Collection,
  keys: Record<string, "text">,
  opts: { name: string; default_language: string },
): Promise<void> {
  try {
    await col.createIndex(keys, opts);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      msg.includes("IndexOptionsConflict") ||
      msg.includes("already exists with different options")
    ) {
      await col.dropIndex(opts.name);
      await col.createIndex(keys, opts);
    } else {
      throw err;
    }
  }
}

export class MongoMemoryDB {
  private client: MongoClient | null = null;
  private db: Db | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(private readonly config: MongoDBConfig) {}

  private async ensureInitialized(): Promise<void> {
    if (this.db) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.doInitialize();
    return this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    const opts = buildClientOptions(this.config.tls);
    this.client = new MongoClient(this.config.uri, opts);
    await this.client.connect();
    this.db = this.client.db(this.config.database);
    await this.createIndexes();
  }

  private async createIndexes(): Promise<void> {
    const db = this.db!;

    // memories: text search on content+summary+domain, plus domain_category compound, tags multikey, TTL on expires_at
    const memories = db.collection("memories");
    await safeCreateTextIndex(
      memories,
      { content: "text", summary: "text", domain: "text" },
      { name: "text_content_summary_domain", default_language: "none" },
    );
    await memories.createIndex({ domain: 1, category: 1 }, { name: "domain_category" });
    await memories.createIndex({ tags: 1 }, { name: "tags" });
    await memories.createIndex(
      { expires_at: 1 },
      {
        name: "ttl_expires_at",
        expireAfterSeconds: 0,
        partialFilterExpression: { expires_at: { $type: "date" } },
      },
    );

    // guidelines: compound domain+task+active, priority, text search
    const guidelines = db.collection("guidelines");
    await safeCreateTextIndex(
      guidelines,
      { title: "text", content: "text", domain: "text" },
      { name: "text_title_content_domain", default_language: "none" },
    );
    await guidelines.createIndex({ domain: 1, task: 1, active: 1 }, { name: "domain_task_active" });
    await guidelines.createIndex({ priority: 1 }, { name: "priority" });

    // seeds: unique name, domain, text search
    const seeds = db.collection("seeds");
    await safeCreateTextIndex(
      seeds,
      { name: "text", description: "text", content: "text" },
      { name: "text_name_description_content", default_language: "none" },
    );
    await seeds.createIndex({ name: 1 }, { name: "name_unique", unique: true });
    await seeds.createIndex({ domain: 1 }, { name: "domain" });

    // agent_config: unique compound type+agent_id, text search on content
    const agentConfig = db.collection("agent_config");
    await safeCreateTextIndex(
      agentConfig,
      { content: "text" },
      { name: "text_content", default_language: "none" },
    );
    await agentConfig.createIndex(
      { type: 1, agent_id: 1 },
      { name: "type_agent_id_unique", unique: true },
    );

    // skills: unique name, triggers multikey, text search
    const skills = db.collection("skills");
    await safeCreateTextIndex(
      skills,
      { name: "text", description: "text", prompt_base: "text" },
      { name: "text_name_description_prompt", default_language: "none" },
    );
    await skills.createIndex({ name: 1 }, { name: "name_unique", unique: true });
    await skills.createIndex({ triggers: 1 }, { name: "triggers" });

    // routing: unique agent_id
    const routing = db.collection("routing");
    await routing.createIndex({ agent_id: 1 }, { name: "agent_id_unique", unique: true });
  }

  async getCollection<T extends Document = Document>(name: CollectionName): Promise<Collection<T>> {
    await this.ensureInitialized();
    return this.db!.collection<T>(name);
  }

  async getDb(): Promise<Db> {
    await this.ensureInitialized();
    return this.db!;
  }

  async ping(): Promise<boolean> {
    try {
      await this.ensureInitialized();
      await this.db!.command({ ping: 1 });
      return true;
    } catch {
      return false;
    }
  }

  async counts(): Promise<Record<CollectionName, number>> {
    await this.ensureInitialized();
    const result = {} as Record<CollectionName, number>;
    for (const name of ALL_COLLECTIONS) {
      result[name] = await this.db!.collection(name).countDocuments();
    }
    return result;
  }

  async close(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
      this.db = null;
      this.initPromise = null;
    }
  }
}
