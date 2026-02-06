import { describe, it, expect, vi } from "vitest";
import { store, search, exportAll, importFromArray } from "../../src/collections/seeds.js";
import { mockCollection, mockCursor } from "../test-helpers.js";

describe("seeds", () => {
  describe("store", () => {
    it("creates a new seed", async () => {
      const col = mockCollection();
      const result = await store(col, {
        name: "greeting-prompt",
        description: "Standard greeting",
        content: "Hello, how can I help?",
        domain: "prompts",
        tags: ["greeting"],
      });
      expect(result.action).toBe("created");
      expect(result.doc.name).toBe("greeting-prompt");
      expect(result.doc.description).toBe("Standard greeting");
      expect(result.doc.domain).toBe("prompts");
      expect(result.doc.tags).toEqual(["greeting"]);
      expect(result.doc.version).toBe(1);
    });

    it("returns duplicate when name already exists", async () => {
      const existing = { name: "greeting-prompt", _id: "x" };
      const col = mockCollection({ findOne: vi.fn().mockResolvedValue(existing) });
      const result = await store(col, {
        name: "greeting-prompt",
        description: "",
        content: "new content",
        domain: "prompts",
      });
      expect(result.action).toBe("duplicate");
      expect(col.insertOne).not.toHaveBeenCalled();
    });

    it("defaults optional fields", async () => {
      const col = mockCollection();
      const result = await store(col, {
        name: "test",
        description: "",
        content: "c",
        domain: "d",
      });
      expect(result.doc.tags).toEqual([]);
      expect(result.doc.dependencies).toEqual([]);
      expect(result.doc.author).toBe("");
    });
  });

  describe("search", () => {
    it("performs text search", async () => {
      const docs = [{ name: "found", score: 1.0 }];
      const cursor = mockCursor(docs);
      const col = mockCollection({ find: vi.fn(() => cursor) });

      const results = await search(col, { query: "greeting" });
      expect(results).toEqual(docs);
      expect(col.find).toHaveBeenCalledWith(
        { $text: { $search: "greeting" } },
        { projection: { score: { $meta: "textScore" } } },
      );
    });

    it("filters by domain", async () => {
      const cursor = mockCursor([]);
      const col = mockCollection({ find: vi.fn(() => cursor) });

      await search(col, { query: "test", domain: "prompts" });
      expect(col.find).toHaveBeenCalledWith(
        { $text: { $search: "test" }, domain: "prompts" },
        expect.anything(),
      );
    });
  });

  describe("exportAll", () => {
    it("exports all seeds, stripping _id and timestamps", async () => {
      const docs = [
        {
          _id: "1",
          name: "a",
          description: "d",
          content: "c",
          domain: "x",
          created_at: new Date(),
          updated_at: new Date(),
          tags: [],
        },
      ];
      const cursor = mockCursor(docs);
      const col = mockCollection({ find: vi.fn(() => cursor) });

      const result = await exportAll(col);
      expect(result[0]).not.toHaveProperty("_id");
      expect(result[0]).not.toHaveProperty("created_at");
      expect(result[0]).not.toHaveProperty("updated_at");
      expect(result[0]).toHaveProperty("name", "a");
    });

    it("filters by domain when provided", async () => {
      const cursor = mockCursor([]);
      const col = mockCollection({ find: vi.fn(() => cursor) });

      await exportAll(col, "prompts");
      expect(col.find).toHaveBeenCalledWith({ domain: "prompts" });
    });
  });

  describe("importFromArray", () => {
    it("upserts seeds by name", async () => {
      const col = mockCollection({
        updateOne: vi.fn().mockResolvedValue({ upsertedId: "new-id", modifiedCount: 0 }),
      });

      const result = await importFromArray(col, [
        { name: "seed1", content: "c1" },
        { name: "seed2", content: "c2" },
      ]);
      expect(result.upserted).toBe(2);
      expect(result.updated).toBe(0);
      expect(result.errors).toHaveLength(0);
      expect(col.updateOne).toHaveBeenCalledTimes(2);
    });

    it("reports errors for seeds without name", async () => {
      const col = mockCollection();
      const result = await importFromArray(col, [{ content: "no name" }]);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].error).toBe("missing name");
    });

    it("counts updates vs upserts", async () => {
      const col = mockCollection({
        updateOne: vi
          .fn()
          .mockResolvedValueOnce({ upsertedId: "id1", modifiedCount: 0 })
          .mockResolvedValueOnce({ upsertedId: null, modifiedCount: 1 }),
      });

      const result = await importFromArray(col, [
        { name: "new-seed", content: "x" },
        { name: "existing-seed", content: "y" },
      ]);
      expect(result.upserted).toBe(1);
      expect(result.updated).toBe(1);
    });
  });
});
