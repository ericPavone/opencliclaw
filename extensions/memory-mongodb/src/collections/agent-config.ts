import type { Collection } from "mongodb";

export type AgentConfigDoc = {
  _id?: unknown;
  type: string;
  agent_id: string;
  content: string;
  version: number;
  created_at: Date;
  updated_at: Date;
};

export const VALID_TYPES = [
  "soul",
  "user",
  "identity",
  "tools",
  "agents",
  "heartbeat",
  "bootstrap",
  "boot",
] as const;

export type AgentConfigType = (typeof VALID_TYPES)[number];

type StoreParams = {
  type: AgentConfigType;
  agentId?: string;
  content: string;
};

type SearchParams = {
  query: string;
  agentId?: string;
  limit?: number;
};

export async function store(
  col: Collection,
  params: StoreParams,
): Promise<{ doc: AgentConfigDoc; action: "created" | "updated" }> {
  const agentId = params.agentId ?? "default";
  const now = new Date();

  const filter = { type: params.type, agent_id: agentId };
  const update = {
    $set: { content: params.content, updated_at: now },
    $setOnInsert: { type: params.type, agent_id: agentId, version: 1, created_at: now },
  };

  const result = await col.updateOne(filter, update, { upsert: true });
  const doc = (await col.findOne(filter)) as unknown as AgentConfigDoc;

  return {
    doc,
    action: result.upsertedId ? "created" : "updated",
  };
}

export async function getConfig(
  col: Collection,
  agentId?: string,
  type?: string,
): Promise<AgentConfigDoc[]> {
  const query: Record<string, unknown> = { agent_id: agentId ?? "default" };
  if (type) query.type = type;

  return col.find(query).sort({ type: 1 }).toArray() as Promise<AgentConfigDoc[]>;
}

export async function search(
  col: Collection,
  params: SearchParams,
): Promise<Array<AgentConfigDoc & { score?: number }>> {
  const limit = params.limit ?? 10;
  const filter: Record<string, unknown> = {};
  if (params.agentId) filter.agent_id = params.agentId;

  const textResults = (await col
    .find(
      { ...filter, $text: { $search: params.query } },
      { projection: { score: { $meta: "textScore" } } },
    )
    .sort({ score: { $meta: "textScore" } })
    .limit(limit)
    .toArray()) as Array<AgentConfigDoc & { score?: number }>;

  if (textResults.length > 0) return textResults;

  const keywords = params.query
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter((w) => w.length >= 3);
  if (keywords.length === 0) return [];

  const pattern = keywords.map((w) => `(?=.*${escapeRegex(w)})`).join("");
  return col
    .find({ ...filter, content: { $regex: pattern, $options: "is" } })
    .sort({ type: 1 })
    .limit(limit)
    .toArray() as Promise<Array<AgentConfigDoc & { score?: number }>>;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function exportConfig(col: Collection, agentId?: string): Promise<AgentConfigDoc[]> {
  const docs = await col
    .find({ agent_id: agentId ?? "default" })
    .sort({ type: 1 })
    .toArray();
  return docs.map((d) => {
    const { _id, created_at, updated_at, ...rest } = d;
    return rest as unknown as AgentConfigDoc;
  });
}

export async function importFromArray(
  col: Collection,
  entries: Array<Record<string, unknown>>,
  agentId?: string,
): Promise<{
  upserted: number;
  updated: number;
  errors: Array<{ entry: unknown; error: string }>;
}> {
  const now = new Date();
  const targetAgent = agentId ?? "default";
  const results = {
    upserted: 0,
    updated: 0,
    errors: [] as Array<{ entry: unknown; error: string }>,
  };

  for (const entry of entries) {
    const cfgType = entry.type;
    if (typeof cfgType !== "string" || !(VALID_TYPES as readonly string[]).includes(cfgType)) {
      results.errors.push({
        entry,
        error: `invalid or missing type (valid: ${VALID_TYPES.join(", ")})`,
      });
      continue;
    }

    const content = typeof entry.content === "string" ? entry.content : "";
    const filter = { type: cfgType, agent_id: targetAgent };
    const update = {
      $set: { content, updated_at: now },
      $setOnInsert: { type: cfgType, agent_id: targetAgent, version: 1, created_at: now },
    };

    const r = await col.updateOne(filter, update, { upsert: true });
    if (r.upsertedId) {
      results.upserted++;
    } else if (r.modifiedCount) {
      results.updated++;
    }
  }

  return results;
}
