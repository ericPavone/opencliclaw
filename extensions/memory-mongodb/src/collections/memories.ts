import type { Collection } from "mongodb";

export type MemoryDoc = {
  _id?: unknown;
  content: string;
  summary: string;
  domain: string;
  category: string;
  tags: string[];
  confidence: number;
  source: string;
  embedding_text: string;
  active: boolean;
  version: number;
  expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

type StoreParams = {
  content: string;
  summary?: string;
  domain: string;
  category?: string;
  tags?: string[];
  confidence?: number;
  source?: string;
  expiresAt?: string;
};

type SearchParams = {
  query: string;
  domain?: string;
  category?: string;
  limit?: number;
};

export async function store(
  col: Collection,
  params: StoreParams,
): Promise<{ doc: MemoryDoc; action: "created" | "duplicate" }> {
  const existing = await col.findOne({ content: params.content, domain: params.domain });
  if (existing) {
    return { doc: existing as unknown as MemoryDoc, action: "duplicate" };
  }

  const now = new Date();
  const doc: MemoryDoc = {
    content: params.content,
    summary: params.summary ?? "",
    domain: params.domain,
    category: params.category ?? "note",
    tags: params.tags ?? [],
    confidence: params.confidence ?? 0.8,
    source: params.source ?? "user",
    embedding_text: `${params.content} ${params.summary ?? ""}`.trim(),
    active: true,
    version: 1,
    expires_at: params.expiresAt ? new Date(params.expiresAt) : null,
    created_at: now,
    updated_at: now,
  };

  const result = await col.insertOne(doc);
  doc._id = result.insertedId;
  return { doc, action: "created" };
}

export async function search(
  col: Collection,
  params: SearchParams,
): Promise<Array<MemoryDoc & { score?: number }>> {
  const query: Record<string, unknown> = { $text: { $search: params.query } };
  if (params.domain) query.domain = params.domain;
  if (params.category) query.category = params.category;

  return col
    .find(query, { projection: { score: { $meta: "textScore" } } })
    .sort({ score: { $meta: "textScore" } })
    .limit(params.limit ?? 10)
    .toArray() as Promise<Array<MemoryDoc & { score?: number }>>;
}

export async function prune(col: Collection): Promise<number> {
  const now = new Date();
  const result = await col.deleteMany({
    expires_at: { $lt: now, $ne: null },
  });
  return result.deletedCount;
}
