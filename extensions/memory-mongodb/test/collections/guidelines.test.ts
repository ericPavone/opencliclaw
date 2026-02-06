import { describe, it, expect, vi } from "vitest";
import { store, search, deactivate } from "../../src/collections/guidelines.js";
import { mockCollection, mockCursor } from "../test-helpers.js";

describe("guidelines", () => {
  describe("store", () => {
    it("creates a new guideline", async () => {
      const col = mockCollection();
      const result = await store(col, {
        title: "Code Review",
        content: "Always review before merge",
        domain: "engineering",
        tags: ["process"],
        priority: 5,
      });
      expect(result.action).toBe("created");
      expect(result.doc.title).toBe("Code Review");
      expect(result.doc.content).toBe("Always review before merge");
      expect(result.doc.domain).toBe("engineering");
      expect(result.doc.priority).toBe(5);
      expect(result.doc.tags).toEqual(["process"]);
      expect(result.doc.active).toBe(true);
      expect(result.doc.version).toBe(1);
      expect(col.insertOne).toHaveBeenCalledOnce();
    });

    it("returns duplicate when content+domain already exists", async () => {
      const existing = { title: "Test", content: "x", domain: "d" };
      const col = mockCollection({ findOne: vi.fn().mockResolvedValue(existing) });
      const result = await store(col, { title: "Test", content: "x", domain: "d" });
      expect(result.action).toBe("duplicate");
      expect(col.insertOne).not.toHaveBeenCalled();
    });

    it("defaults optional fields", async () => {
      const col = mockCollection();
      const result = await store(col, { title: "T", content: "C", domain: "D" });
      expect(result.doc.task).toBe("");
      expect(result.doc.priority).toBe(0);
      expect(result.doc.tags).toEqual([]);
      expect(result.doc.input_format).toBe("");
      expect(result.doc.output_format).toBe("");
    });
  });

  describe("search", () => {
    it("searches active guidelines with text query", async () => {
      const docs = [{ title: "Found", score: 2.0 }];
      const cursor = mockCursor(docs);
      const col = mockCollection({ find: vi.fn(() => cursor) });

      const results = await search(col, { query: "review" });
      expect(results).toEqual(docs);
      expect(col.find).toHaveBeenCalledWith(
        { $text: { $search: "review" }, active: true },
        { projection: { score: { $meta: "textScore" } } },
      );
    });

    it("adds domain and task filters", async () => {
      const cursor = mockCursor([]);
      const col = mockCollection({ find: vi.fn(() => cursor) });

      await search(col, { query: "test", domain: "eng", task: "review" });
      expect(col.find).toHaveBeenCalledWith(
        { $text: { $search: "test" }, active: true, domain: "eng", task: "review" },
        expect.anything(),
      );
    });
  });

  describe("deactivate", () => {
    it("deactivates guidelines by title", async () => {
      const col = mockCollection({
        updateMany: vi.fn().mockResolvedValue({ modifiedCount: 2 }),
      });
      const count = await deactivate(col, "Old Rule");
      expect(count).toBe(2);
      expect(col.updateMany).toHaveBeenCalledWith(
        { title: "Old Rule" },
        { $set: { active: false, updated_at: expect.any(Date) } },
      );
    });

    it("adds domain filter when provided", async () => {
      const col = mockCollection({
        updateMany: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
      });
      await deactivate(col, "Rule", "engineering");
      expect(col.updateMany).toHaveBeenCalledWith(
        { title: "Rule", domain: "engineering" },
        expect.anything(),
      );
    });

    it("returns 0 when no match", async () => {
      const col = mockCollection({
        updateMany: vi.fn().mockResolvedValue({ modifiedCount: 0 }),
      });
      const count = await deactivate(col, "Nonexistent");
      expect(count).toBe(0);
    });
  });
});
