import { describe, it, expect, vi } from "vitest";
import {
  store,
  search,
  getSkill,
  matchByTrigger,
  activate,
  deactivate,
  exportAll,
  importFromArray,
} from "../../src/collections/skills.js";
import { mockCollection, mockCursor } from "../test-helpers.js";

describe("skills", () => {
  describe("store", () => {
    it("creates a new skill", async () => {
      const col = mockCollection();
      const result = await store(col, {
        name: "code-review",
        description: "Review code quality",
        promptBase: "You are a code reviewer...",
        triggers: ["review", "check"],
      });
      expect(result.action).toBe("created");
      expect(result.doc.name).toBe("code-review");
      expect(result.doc.description).toBe("Review code quality");
      expect(result.doc.prompt_base).toBe("You are a code reviewer...");
      expect(result.doc.triggers).toEqual(["review", "check"]);
      expect(result.doc.active).toBe(true);
      expect(result.doc.version).toBe(1);
    });

    it("returns duplicate when name exists", async () => {
      const existing = { name: "code-review", _id: "x" };
      const col = mockCollection({ findOne: vi.fn().mockResolvedValue(existing) });
      const result = await store(col, { name: "code-review", description: "d" });
      expect(result.action).toBe("duplicate");
      expect(col.insertOne).not.toHaveBeenCalled();
    });

    it("defaults optional fields", async () => {
      const col = mockCollection();
      const result = await store(col, { name: "test", description: "" });
      expect(result.doc.prompt_base).toBe("");
      expect(result.doc.triggers).toEqual([]);
      expect(result.doc.depends_on).toEqual([]);
      expect(result.doc.guidelines).toEqual([]);
      expect(result.doc.seeds).toEqual([]);
      expect(result.doc.tools).toEqual([]);
      expect(result.doc.examples).toEqual([]);
      expect(result.doc.references).toEqual([]);
    });
  });

  describe("search", () => {
    it("performs text search", async () => {
      const docs = [{ name: "found", score: 1.0 }];
      const cursor = mockCursor(docs);
      const col = mockCollection({ find: vi.fn(() => cursor) });

      const results = await search(col, { query: "review" });
      expect(results).toEqual(docs);
    });

    it("filters by active when requested", async () => {
      const cursor = mockCursor([]);
      const col = mockCollection({ find: vi.fn(() => cursor) });

      await search(col, { query: "test", activeOnly: true });
      expect(col.find).toHaveBeenCalledWith(
        { $text: { $search: "test" }, active: true },
        expect.anything(),
      );
    });
  });

  describe("getSkill", () => {
    it("returns skill by name", async () => {
      const doc = { name: "code-review", description: "d" };
      const col = mockCollection({ findOne: vi.fn().mockResolvedValue(doc) });

      const result = await getSkill(col, "code-review");
      expect(result).toEqual(doc);
      expect(col.findOne).toHaveBeenCalledWith({ name: "code-review" });
    });

    it("returns null when not found", async () => {
      const col = mockCollection();
      const result = await getSkill(col, "nonexistent");
      expect(result).toBeNull();
    });
  });

  describe("matchByTrigger", () => {
    it("finds active skills by trigger", async () => {
      const docs = [{ name: "review", triggers: ["review"] }];
      const cursor = mockCursor(docs);
      const col = mockCollection({ find: vi.fn(() => cursor) });

      const results = await matchByTrigger(col, "review");
      expect(results).toEqual(docs);
      expect(col.find).toHaveBeenCalledWith({ triggers: "review", active: true });
    });
  });

  describe("activate", () => {
    it("activates a skill by name", async () => {
      const col = mockCollection({
        updateOne: vi.fn().mockResolvedValue({ matchedCount: 1 }),
      });
      const result = await activate(col, "my-skill");
      expect(result).toBe(true);
      expect(col.updateOne).toHaveBeenCalledWith(
        { name: "my-skill" },
        { $set: { active: true, updated_at: expect.any(Date) } },
      );
    });

    it("returns false when skill not found", async () => {
      const col = mockCollection({
        updateOne: vi.fn().mockResolvedValue({ matchedCount: 0 }),
      });
      const result = await activate(col, "nonexistent");
      expect(result).toBe(false);
    });
  });

  describe("deactivate", () => {
    it("deactivates a skill by name", async () => {
      const col = mockCollection({
        updateOne: vi.fn().mockResolvedValue({ matchedCount: 1 }),
      });
      const result = await deactivate(col, "my-skill");
      expect(result).toBe(true);
      expect(col.updateOne).toHaveBeenCalledWith(
        { name: "my-skill" },
        { $set: { active: false, updated_at: expect.any(Date) } },
      );
    });
  });

  describe("exportAll", () => {
    it("exports all skills, stripping internal fields", async () => {
      const docs = [
        {
          _id: "1",
          name: "s1",
          description: "d",
          created_at: new Date(),
          updated_at: new Date(),
          active: true,
        },
      ];
      const cursor = mockCursor(docs);
      const col = mockCollection({ find: vi.fn(() => cursor) });

      const result = await exportAll(col);
      expect(result[0]).not.toHaveProperty("_id");
      expect(result[0]).not.toHaveProperty("created_at");
      expect(result[0]).not.toHaveProperty("updated_at");
      expect(result[0]).toHaveProperty("name", "s1");
    });

    it("filters by name when provided", async () => {
      const cursor = mockCursor([]);
      const col = mockCollection({ find: vi.fn(() => cursor) });

      await exportAll(col, "specific-skill");
      expect(col.find).toHaveBeenCalledWith({ name: "specific-skill" });
    });
  });

  describe("importFromArray", () => {
    it("upserts skills", async () => {
      const col = mockCollection({
        updateOne: vi.fn().mockResolvedValue({ upsertedId: "id", modifiedCount: 0 }),
      });
      const result = await importFromArray(col, [
        { name: "s1", prompt_base: "p", triggers: ["t"] },
      ]);
      expect(result.upserted).toBe(1);
      expect(result.errors).toHaveLength(0);
    });

    it("rejects skills without name", async () => {
      const col = mockCollection();
      const result = await importFromArray(col, [{ prompt_base: "x" }]);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].error).toBe("missing name");
    });

    it("counts updates and upserts separately", async () => {
      const col = mockCollection({
        updateOne: vi
          .fn()
          .mockResolvedValueOnce({ upsertedId: "id", modifiedCount: 0 })
          .mockResolvedValueOnce({ upsertedId: null, modifiedCount: 1 }),
      });
      const result = await importFromArray(col, [
        { name: "new", prompt_base: "x" },
        { name: "existing", prompt_base: "y" },
      ]);
      expect(result.upserted).toBe(1);
      expect(result.updated).toBe(1);
    });

    it("defaults optional fields during import", async () => {
      const col = mockCollection({
        updateOne: vi.fn().mockResolvedValue({ upsertedId: "id" }),
      });
      await importFromArray(col, [{ name: "minimal" }]);
      const updateCall = (col.updateOne as ReturnType<typeof vi.fn>).mock.calls[0];
      const setDoc = updateCall[1].$set;
      expect(setDoc.prompt_base).toBe("");
      expect(setDoc.triggers).toEqual([]);
      expect(setDoc.depends_on).toEqual([]);
      expect(setDoc.active).toBe(true);
    });
  });
});
