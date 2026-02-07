import type { Collection } from "mongodb";

export type SeedDoc = {
  _id?: unknown;
  name: string;
  description: string;
  content: string;
  domain: string;
  tags: string[];
  dependencies: string[];
  version: number;
  author: string;
  created_at: Date;
  updated_at: Date;
};

type StoreParams = {
  name: string;
  description: string;
  content: string;
  domain: string;
  tags?: string[];
  dependencies?: string[];
  author?: string;
};

type SearchParams = {
  query: string;
  domain?: string;
  limit?: number;
};

export async function store(
  col: Collection,
  params: StoreParams,
): Promise<{ doc: SeedDoc; action: "created" | "duplicate" }> {
  const existing = await col.findOne({ name: params.name });
  if (existing) {
    return { doc: existing as unknown as SeedDoc, action: "duplicate" };
  }

  const now = new Date();
  const doc: SeedDoc = {
    name: params.name,
    description: params.description,
    content: params.content,
    domain: params.domain,
    tags: params.tags ?? [],
    dependencies: params.dependencies ?? [],
    version: 1,
    author: params.author ?? "",
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
): Promise<Array<SeedDoc & { score?: number }>> {
  const limit = params.limit ?? 10;
  const filter: Record<string, unknown> = {};
  if (params.domain) filter.domain = params.domain;

  const textResults = (await col
    .find(
      { ...filter, $text: { $search: params.query } },
      { projection: { score: { $meta: "textScore" } } },
    )
    .sort({ score: { $meta: "textScore" } })
    .limit(limit)
    .toArray()) as Array<SeedDoc & { score?: number }>;

  if (textResults.length > 0) return textResults;

  const keywords = params.query
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter((w) => w.length >= 3);
  if (keywords.length === 0) return [];

  const pattern = keywords.map((w) => `(?=.*${escapeRegex(w)})`).join("");
  return col
    .find({
      ...filter,
      $or: [
        { content: { $regex: pattern, $options: "is" } },
        { name: { $regex: pattern, $options: "is" } },
        { description: { $regex: pattern, $options: "is" } },
      ],
    })
    .sort({ updated_at: -1 })
    .limit(limit)
    .toArray() as Promise<Array<SeedDoc & { score?: number }>>;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function exportAll(col: Collection, domain?: string): Promise<SeedDoc[]> {
  const query: Record<string, unknown> = {};
  if (domain) query.domain = domain;

  const docs = await col.find(query).toArray();
  return docs.map((d) => {
    const { _id, created_at, updated_at, ...rest } = d;
    return rest as unknown as SeedDoc;
  });
}

export async function importFromArray(
  col: Collection,
  seeds: Array<Record<string, unknown>>,
): Promise<{ upserted: number; updated: number; errors: Array<{ seed: unknown; error: string }> }> {
  const now = new Date();
  const results = {
    upserted: 0,
    updated: 0,
    errors: [] as Array<{ seed: unknown; error: string }>,
  };

  for (const s of seeds) {
    const name = s.name;
    if (typeof name !== "string" || !name) {
      results.errors.push({ seed: s, error: "missing name" });
      continue;
    }

    const updateDoc = { ...s, updated_at: now };
    delete updateDoc.created_at;
    const createdAt = s.created_at ?? now;

    const r = await col.updateOne(
      { name },
      { $set: updateDoc, $setOnInsert: { created_at: createdAt } },
      { upsert: true },
    );
    if (r.upsertedId) {
      results.upserted++;
    } else if (r.modifiedCount) {
      results.updated++;
    }
  }

  return results;
}
