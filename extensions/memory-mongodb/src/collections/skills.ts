import type { Collection } from "mongodb";

export type SkillDoc = {
  _id?: unknown;
  name: string;
  description: string;
  version: number;
  prompt_base: string;
  triggers: string[];
  depends_on: string[];
  guidelines: unknown[];
  seeds: unknown[];
  tools: unknown[];
  examples: unknown[];
  references: unknown[];
  active: boolean;
  created_at: Date;
  updated_at: Date;
};

type StoreParams = {
  name: string;
  description: string;
  promptBase?: string;
  triggers?: string[];
  dependsOn?: string[];
};

type SearchParams = {
  query: string;
  activeOnly?: boolean;
  limit?: number;
};

export async function store(
  col: Collection,
  params: StoreParams,
): Promise<{ doc: SkillDoc; action: "created" | "duplicate" }> {
  const existing = await col.findOne({ name: params.name });
  if (existing) {
    return { doc: existing as unknown as SkillDoc, action: "duplicate" };
  }

  const now = new Date();
  const doc: SkillDoc = {
    name: params.name,
    description: params.description,
    version: 1,
    prompt_base: params.promptBase ?? "",
    triggers: params.triggers ?? [],
    depends_on: params.dependsOn ?? [],
    guidelines: [],
    seeds: [],
    tools: [],
    examples: [],
    references: [],
    active: true,
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
): Promise<Array<SkillDoc & { score?: number }>> {
  const limit = params.limit ?? 10;
  const filter: Record<string, unknown> = {};
  if (params.activeOnly) filter.active = true;

  const textResults = (await col
    .find(
      { ...filter, $text: { $search: params.query } },
      { projection: { score: { $meta: "textScore" } } },
    )
    .sort({ score: { $meta: "textScore" } })
    .limit(limit)
    .toArray()) as Array<SkillDoc & { score?: number }>;

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
        { name: { $regex: pattern, $options: "is" } },
        { description: { $regex: pattern, $options: "is" } },
        { prompt_base: { $regex: pattern, $options: "is" } },
      ],
    })
    .sort({ updated_at: -1 })
    .limit(limit)
    .toArray() as Promise<Array<SkillDoc & { score?: number }>>;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function getSkill(col: Collection, name: string): Promise<SkillDoc | null> {
  const doc = await col.findOne({ name });
  return doc as unknown as SkillDoc | null;
}

export async function matchByTrigger(col: Collection, trigger: string): Promise<SkillDoc[]> {
  return col.find({ triggers: trigger, active: true }).toArray() as Promise<SkillDoc[]>;
}

export async function activate(col: Collection, name: string): Promise<boolean> {
  const result = await col.updateOne({ name }, { $set: { active: true, updated_at: new Date() } });
  return result.matchedCount > 0;
}

export async function deactivate(col: Collection, name: string): Promise<boolean> {
  const result = await col.updateOne({ name }, { $set: { active: false, updated_at: new Date() } });
  return result.matchedCount > 0;
}

export async function exportAll(col: Collection, name?: string): Promise<SkillDoc[]> {
  const query: Record<string, unknown> = {};
  if (name) query.name = name;

  const docs = await col.find(query).toArray();
  return docs.map((d) => {
    const { _id, created_at, updated_at, ...rest } = d;
    return rest as unknown as SkillDoc;
  });
}

export async function importFromArray(
  col: Collection,
  data: Array<Record<string, unknown>>,
): Promise<{
  upserted: number;
  updated: number;
  errors: Array<{ skill: unknown; error: string }>;
}> {
  const now = new Date();
  const results = {
    upserted: 0,
    updated: 0,
    errors: [] as Array<{ skill: unknown; error: string }>,
  };

  for (const s of data) {
    const name = s.name;
    if (typeof name !== "string" || !name) {
      results.errors.push({ skill: s, error: "missing name" });
      continue;
    }

    const updateDoc: Record<string, unknown> = {
      ...s,
      updated_at: now,
      version: s.version ?? 1,
      prompt_base: s.prompt_base ?? "",
      triggers: s.triggers ?? [],
      depends_on: s.depends_on ?? [],
      guidelines: s.guidelines ?? [],
      seeds: s.seeds ?? [],
      tools: s.tools ?? [],
      examples: s.examples ?? [],
      references: s.references ?? [],
      active: s.active ?? true,
    };
    const createdAt = s.created_at ?? now;
    delete updateDoc.created_at;

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
