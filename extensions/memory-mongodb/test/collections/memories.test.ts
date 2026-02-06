import { describe, it, expect, vi } from "vitest";
import { store, search, prune } from "../../src/collections/memories.js";
import { mockCollection, mockCursor } from "../test-helpers.js";

describe("memories", () => {
  describe("store", () => {
    it("creates a new memory when no duplicate exists", async () => {
      const col = mockCollection();
      const result = await store(col, {
        content: "User prefers dark mode",
        domain: "preferences",
        category: "preference",
        tags: ["ui"],
      });
      expect(result.action).toBe("created");
      expect(result.doc.content).toBe("User prefers dark mode");
      expect(result.doc.domain).toBe("preferences");
      expect(result.doc.category).toBe("preference");
      expect(result.doc.tags).toEqual(["ui"]);
      expect(result.doc.active).toBe(true);
      expect(result.doc.version).toBe(1);
      expect(result.doc.confidence).toBe(0.8);
      expect(result.doc.source).toBe("user");
      expect(col.insertOne).toHaveBeenCalledOnce();
    });

    it("returns duplicate when identical content+domain exists", async () => {
      const existing = { content: "test", domain: "general", _id: "existing-id" };
      const col = mockCollection({ findOne: vi.fn().mockResolvedValue(existing) });
      const result = await store(col, { content: "test", domain: "general" });
      expect(result.action).toBe("duplicate");
      expect(col.insertOne).not.toHaveBeenCalled();
    });

    it("applies default values for optional fields", async () => {
      const col = mockCollection();
      const result = await store(col, { content: "hello", domain: "general" });
      expect(result.doc.category).toBe("note");
      expect(result.doc.tags).toEqual([]);
      expect(result.doc.summary).toBe("");
      expect(result.doc.source).toBe("user");
      expect(result.doc.expires_at).toBeNull();
    });

    it("sets custom confidence and source", async () => {
      const col = mockCollection();
      const result = await store(col, {
        content: "auto captured",
        domain: "auto",
        confidence: 0.5,
        source: "auto-capture",
      });
      expect(result.doc.confidence).toBe(0.5);
      expect(result.doc.source).toBe("auto-capture");
    });

    it("builds embedding_text from content and summary", async () => {
      const col = mockCollection();
      const result = await store(col, {
        content: "some content",
        domain: "test",
        summary: "a summary",
      });
      expect(result.doc.embedding_text).toBe("some content a summary");
    });
  });

  describe("search", () => {
    it("builds text search query and returns results", async () => {
      const docs = [{ content: "result", score: 1.5 }];
      const cursor = mockCursor(docs);
      const col = mockCollection({ find: vi.fn(() => cursor) });

      const results = await search(col, { query: "test query" });
      expect(results).toEqual(docs);
      expect(col.find).toHaveBeenCalledWith(
        { $text: { $search: "test query" } },
        { projection: { score: { $meta: "textScore" } } },
      );
      expect(cursor.sort).toHaveBeenCalledWith({ score: { $meta: "textScore" } });
      expect(cursor.limit).toHaveBeenCalledWith(10);
    });

    it("adds domain filter when provided", async () => {
      const cursor = mockCursor([]);
      const col = mockCollection({ find: vi.fn(() => cursor) });

      await search(col, { query: "test", domain: "prefs" });
      expect(col.find).toHaveBeenCalledWith(
        { $text: { $search: "test" }, domain: "prefs" },
        expect.anything(),
      );
    });

    it("respects custom limit", async () => {
      const cursor = mockCursor([]);
      const col = mockCollection({ find: vi.fn(() => cursor) });

      await search(col, { query: "test", limit: 5 });
      expect(cursor.limit).toHaveBeenCalledWith(5);
    });
  });

  describe("prune", () => {
    it("deletes expired memories and returns count", async () => {
      const col = mockCollection({
        deleteMany: vi.fn().mockResolvedValue({ deletedCount: 3 }),
      });
      const count = await prune(col);
      expect(count).toBe(3);
      expect(col.deleteMany).toHaveBeenCalledOnce();
    });
  });
});
