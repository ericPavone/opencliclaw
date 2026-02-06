import { describe, it, expect, vi } from "vitest";
import {
  store,
  getConfig,
  search,
  exportConfig,
  importFromArray,
  VALID_TYPES,
} from "../../src/collections/agent-config.js";
import { mockCollection, mockCursor } from "../test-helpers.js";

describe("agent-config", () => {
  describe("VALID_TYPES", () => {
    it("contains expected config types", () => {
      expect(VALID_TYPES).toContain("soul");
      expect(VALID_TYPES).toContain("identity");
      expect(VALID_TYPES).toContain("tools");
      expect(VALID_TYPES).toContain("agents");
      expect(VALID_TYPES).toContain("user");
      expect(VALID_TYPES).toContain("heartbeat");
      expect(VALID_TYPES).toContain("bootstrap");
      expect(VALID_TYPES).toContain("boot");
    });
  });

  describe("store", () => {
    it("creates new config via upsert", async () => {
      const storedDoc = { type: "soul", agent_id: "main", content: "You are helpful", version: 1 };
      const col = mockCollection({
        updateOne: vi.fn().mockResolvedValue({ upsertedId: "new-id", modifiedCount: 0 }),
        findOne: vi.fn().mockResolvedValue(storedDoc),
      });

      const result = await store(col, {
        type: "soul",
        agentId: "main",
        content: "You are helpful",
      });
      expect(result.action).toBe("created");
      expect(result.doc.type).toBe("soul");
      expect(result.doc.content).toBe("You are helpful");
      expect(col.updateOne).toHaveBeenCalledWith(
        { type: "soul", agent_id: "main" },
        expect.objectContaining({
          $set: expect.objectContaining({ content: "You are helpful" }),
        }),
        { upsert: true },
      );
    });

    it("updates existing config", async () => {
      const storedDoc = { type: "soul", agent_id: "default", content: "updated" };
      const col = mockCollection({
        updateOne: vi.fn().mockResolvedValue({ upsertedId: null, modifiedCount: 1 }),
        findOne: vi.fn().mockResolvedValue(storedDoc),
      });

      const result = await store(col, { type: "soul", content: "updated" });
      expect(result.action).toBe("updated");
    });

    it("defaults agentId to 'default'", async () => {
      const col = mockCollection({
        updateOne: vi.fn().mockResolvedValue({ upsertedId: "id" }),
        findOne: vi.fn().mockResolvedValue({ type: "soul", agent_id: "default" }),
      });

      await store(col, { type: "soul", content: "test" });
      expect(col.updateOne).toHaveBeenCalledWith(
        { type: "soul", agent_id: "default" },
        expect.anything(),
        expect.anything(),
      );
    });
  });

  describe("getConfig", () => {
    it("returns all configs for an agent", async () => {
      const docs = [
        { type: "soul", agent_id: "main", content: "soul content" },
        { type: "identity", agent_id: "main", content: "identity content" },
      ];
      const cursor = mockCursor(docs);
      const sortedCursor = { ...cursor, sort: vi.fn(() => cursor) };
      const col = mockCollection({ find: vi.fn(() => sortedCursor) });

      const result = await getConfig(col, "main");
      expect(result).toEqual(docs);
      expect(col.find).toHaveBeenCalledWith({ agent_id: "main" });
    });

    it("filters by type when provided", async () => {
      const cursor = mockCursor([]);
      const sortedCursor = { ...cursor, sort: vi.fn(() => cursor) };
      const col = mockCollection({ find: vi.fn(() => sortedCursor) });

      await getConfig(col, "main", "soul");
      expect(col.find).toHaveBeenCalledWith({ agent_id: "main", type: "soul" });
    });

    it("defaults agentId to 'default'", async () => {
      const cursor = mockCursor([]);
      const sortedCursor = { ...cursor, sort: vi.fn(() => cursor) };
      const col = mockCollection({ find: vi.fn(() => sortedCursor) });

      await getConfig(col);
      expect(col.find).toHaveBeenCalledWith({ agent_id: "default" });
    });
  });

  describe("search", () => {
    it("performs text search", async () => {
      const docs = [{ type: "soul", content: "helpful", score: 1.5 }];
      const cursor = mockCursor(docs);
      const col = mockCollection({ find: vi.fn(() => cursor) });

      const results = await search(col, { query: "helpful" });
      expect(results).toEqual(docs);
    });

    it("adds agentId filter", async () => {
      const cursor = mockCursor([]);
      const col = mockCollection({ find: vi.fn(() => cursor) });

      await search(col, { query: "test", agentId: "agent-1" });
      expect(col.find).toHaveBeenCalledWith(
        { $text: { $search: "test" }, agent_id: "agent-1" },
        expect.anything(),
      );
    });
  });

  describe("exportConfig", () => {
    it("exports config, stripping _id and timestamps", async () => {
      const docs = [
        {
          _id: "1",
          type: "soul",
          agent_id: "default",
          content: "x",
          created_at: new Date(),
          updated_at: new Date(),
        },
      ];
      const cursor = mockCursor(docs);
      const sortedCursor = { ...cursor, sort: vi.fn(() => cursor) };
      const col = mockCollection({ find: vi.fn(() => sortedCursor) });

      const result = await exportConfig(col);
      expect(result[0]).not.toHaveProperty("_id");
      expect(result[0]).not.toHaveProperty("created_at");
      expect(result[0]).not.toHaveProperty("updated_at");
      expect(result[0]).toHaveProperty("type", "soul");
    });
  });

  describe("importFromArray", () => {
    it("upserts valid entries", async () => {
      const col = mockCollection({
        updateOne: vi.fn().mockResolvedValue({ upsertedId: "id", modifiedCount: 0 }),
      });

      const result = await importFromArray(col, [
        { type: "soul", content: "be kind" },
        { type: "identity", content: "Agent X" },
      ]);
      expect(result.upserted).toBe(2);
      expect(result.errors).toHaveLength(0);
    });

    it("rejects entries with invalid type", async () => {
      const col = mockCollection();
      const result = await importFromArray(col, [{ type: "invalid_type", content: "x" }]);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].error).toContain("invalid or missing type");
    });

    it("rejects entries without type", async () => {
      const col = mockCollection();
      const result = await importFromArray(col, [{ content: "no type" }]);
      expect(result.errors).toHaveLength(1);
    });

    it("uses provided agentId for all entries", async () => {
      const col = mockCollection({
        updateOne: vi.fn().mockResolvedValue({ upsertedId: "id" }),
      });

      await importFromArray(col, [{ type: "soul", content: "x" }], "custom-agent");
      expect(col.updateOne).toHaveBeenCalledWith(
        { type: "soul", agent_id: "custom-agent" },
        expect.anything(),
        expect.anything(),
      );
    });
  });
});
