import type { Collection } from "mongodb";

export type GuidelineDoc = {
  _id?: unknown;
  title: string;
  content: string;
  domain: string;
  task: string;
  priority: number;
  tags: string[];
  input_format: string;
  output_format: string;
  active: boolean;
  version: number;
  created_at: Date;
  updated_at: Date;
};

type StoreParams = {
  title: string;
  content: string;
  domain: string;
  task?: string;
  priority?: number;
  tags?: string[];
  inputFormat?: string;
  outputFormat?: string;
};

type SearchParams = {
  query: string;
  domain?: string;
  task?: string;
  limit?: number;
};

export async function store(
  col: Collection,
  params: StoreParams,
): Promise<{ doc: GuidelineDoc; action: "created" | "duplicate" }> {
  const existing = await col.findOne({ content: params.content, domain: params.domain });
  if (existing) {
    return { doc: existing as unknown as GuidelineDoc, action: "duplicate" };
  }

  const now = new Date();
  const doc: GuidelineDoc = {
    title: params.title,
    content: params.content,
    domain: params.domain,
    task: params.task ?? "",
    priority: params.priority ?? 0,
    tags: params.tags ?? [],
    input_format: params.inputFormat ?? "",
    output_format: params.outputFormat ?? "",
    active: true,
    version: 1,
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
): Promise<Array<GuidelineDoc & { score?: number }>> {
  const limit = params.limit ?? 10;
  const filter: Record<string, unknown> = { active: true };
  if (params.domain) filter.domain = params.domain;
  if (params.task) filter.task = params.task;

  const textResults = (await col
    .find(
      { ...filter, $text: { $search: params.query } },
      { projection: { score: { $meta: "textScore" } } },
    )
    .sort({ score: { $meta: "textScore" } })
    .limit(limit)
    .toArray()) as Array<GuidelineDoc & { score?: number }>;

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
        { title: { $regex: pattern, $options: "is" } },
        { content: { $regex: pattern, $options: "is" } },
      ],
    })
    .sort({ priority: -1 })
    .limit(limit)
    .toArray() as Promise<Array<GuidelineDoc & { score?: number }>>;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function deactivate(col: Collection, title: string, domain?: string): Promise<number> {
  const query: Record<string, unknown> = { title };
  if (domain) query.domain = domain;

  const result = await col.updateMany(query, {
    $set: { active: false, updated_at: new Date() },
  });
  return result.modifiedCount;
}
