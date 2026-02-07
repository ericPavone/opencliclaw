import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  CONFIG_TYPE_TO_FILE,
  FILE_TO_CONFIG_TYPE,
  withTimeout,
  autoMigrate,
  replaceBootstrapFiles,
  injectWorkingMemory,
  registerBootstrapHook,
} from "../src/bootstrap-hook.js";
import { mockCollection, mockCursor } from "./test-helpers.js";

type BootstrapFile = {
  name: string;
  path: string;
  content?: string;
  missing: boolean;
};

type BootstrapContext = {
  workspaceDir: string;
  bootstrapFiles: BootstrapFile[];
  agentId?: string;
};

function makeFile(name: string, content = "disk content"): BootstrapFile {
  return { name, path: `/workspace/${name}`, content, missing: false };
}

function makeMissingFile(name: string): BootstrapFile {
  return { name, path: `/workspace/${name}`, missing: true };
}

function makeContext(files: BootstrapFile[]): BootstrapContext {
  return { workspaceDir: "/workspace", bootstrapFiles: files, agentId: "main" };
}

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const mockApi = {
  logger: mockLogger,
} as any;

function mockDb(overrides?: {
  agentConfigDocs?: Array<Record<string, unknown>>;
  memoriesDocs?: Array<Record<string, unknown>>;
}) {
  const agentConfigCol = mockCollection({
    find: vi.fn(() => {
      const docs = overrides?.agentConfigDocs ?? [];
      return mockCursor(docs);
    }),
  });
  const memoriesCol = mockCollection({
    find: vi.fn(() => {
      const docs = overrides?.memoriesDocs ?? [];
      const cursor = mockCursor(docs);
      return { ...cursor, sort: vi.fn(() => cursor), limit: vi.fn(() => cursor) };
    }),
  });

  return {
    getCollection: vi.fn(async (name: string) => {
      if (name === "agent_config") return agentConfigCol;
      if (name === "memories") return memoriesCol;
      return mockCollection();
    }),
    agentConfigCol,
    memoriesCol,
  };
}

describe("bootstrap-hook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("CONFIG_TYPE_TO_FILE / FILE_TO_CONFIG_TYPE", () => {
    it("maps all 8 config types to filenames", () => {
      expect(Object.keys(CONFIG_TYPE_TO_FILE)).toHaveLength(8);
      expect(CONFIG_TYPE_TO_FILE.soul).toBe("SOUL.md");
      expect(CONFIG_TYPE_TO_FILE.tools).toBe("TOOLS.md");
      expect(CONFIG_TYPE_TO_FILE.identity).toBe("IDENTITY.md");
      expect(CONFIG_TYPE_TO_FILE.boot).toBe("BOOT.md");
    });

    it("reverse map is consistent", () => {
      for (const [type, file] of Object.entries(CONFIG_TYPE_TO_FILE)) {
        expect(FILE_TO_CONFIG_TYPE[file]).toBe(type);
      }
    });
  });

  describe("withTimeout", () => {
    it("resolves before timeout", async () => {
      const result = await withTimeout(Promise.resolve("ok"), 1000);
      expect(result).toBe("ok");
    });

    it("rejects on timeout", async () => {
      const slow = new Promise((resolve) => setTimeout(resolve, 5000));
      await expect(withTimeout(slow, 10)).rejects.toThrow("timed out");
    });
  });

  describe("replaceBootstrapFiles", () => {
    it("replaces files that have DB counterparts", () => {
      const context = makeContext([
        makeFile("SOUL.md"),
        makeFile("TOOLS.md"),
        makeFile("IDENTITY.md"),
      ]);
      const docs = [
        { type: "soul", agent_id: "main", content: "DB soul", version: 1 },
        { type: "tools", agent_id: "main", content: "DB tools", version: 1 },
      ] as any[];

      replaceBootstrapFiles(context, docs);

      expect(context.bootstrapFiles[0].content).toBe("DB soul");
      expect(context.bootstrapFiles[0].missing).toBe(false);
      expect(context.bootstrapFiles[1].content).toBe("DB tools");
      expect(context.bootstrapFiles[2].content).toBe("disk content");
    });

    it("leaves disk files intact when no DB match", () => {
      const context = makeContext([makeFile("IDENTITY.md")]);
      const docs: any[] = [];

      replaceBootstrapFiles(context, docs);

      expect(context.bootstrapFiles[0].content).toBe("disk content");
    });

    it("appends DB docs that have no disk file match", () => {
      const context = makeContext([makeFile("SOUL.md")]);
      const docs = [
        { type: "soul", agent_id: "main", content: "DB soul", version: 1 },
        { type: "heartbeat", agent_id: "main", content: "DB heartbeat", version: 1 },
      ] as any[];

      replaceBootstrapFiles(context, docs);

      expect(context.bootstrapFiles).toHaveLength(2);
      expect(context.bootstrapFiles[1].name).toBe("HEARTBEAT.md");
      expect(context.bootstrapFiles[1].content).toBe("DB heartbeat");
      expect(context.bootstrapFiles[1].path).toBe("db://heartbeat");
    });

    it("handles partial DB (per-file merge)", () => {
      const context = makeContext([
        makeFile("SOUL.md"),
        makeFile("TOOLS.md"),
        makeFile("IDENTITY.md"),
        makeFile("USER.md"),
      ]);
      const docs = [
        { type: "soul", agent_id: "main", content: "DB soul", version: 1 },
        { type: "tools", agent_id: "main", content: "DB tools", version: 1 },
      ] as any[];

      replaceBootstrapFiles(context, docs);

      expect(context.bootstrapFiles[0].content).toBe("DB soul");
      expect(context.bootstrapFiles[1].content).toBe("DB tools");
      expect(context.bootstrapFiles[2].content).toBe("disk content");
      expect(context.bootstrapFiles[3].content).toBe("disk content");
    });
  });

  describe("autoMigrate", () => {
    it("stores workspace files as agent_config docs", async () => {
      const col = mockCollection({
        updateOne: vi.fn().mockResolvedValue({ upsertedId: "new-id" }),
        findOne: vi.fn().mockResolvedValue({ type: "soul", agent_id: "main", content: "x" }),
      });

      const files = [makeFile("SOUL.md", "my soul"), makeFile("TOOLS.md", "my tools")];

      await autoMigrate(col, files, "main", mockApi);

      expect(col.updateOne).toHaveBeenCalledTimes(2);
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining("auto-migrated 2 workspace files"),
      );
    });

    it("skips files without a config type mapping", async () => {
      const col = mockCollection({
        updateOne: vi.fn().mockResolvedValue({ upsertedId: "new-id" }),
        findOne: vi.fn().mockResolvedValue(null),
      });

      const files = [makeFile("RANDOM.md", "stuff")];

      await autoMigrate(col, files, "main", mockApi);

      expect(col.updateOne).not.toHaveBeenCalled();
    });

    it("skips files without content", async () => {
      const col = mockCollection({
        updateOne: vi.fn().mockResolvedValue({ upsertedId: "new-id" }),
        findOne: vi.fn().mockResolvedValue(null),
      });

      const files = [{ name: "SOUL.md", path: "/workspace/SOUL.md", missing: false }];

      await autoMigrate(col, files as any, "main", mockApi);

      expect(col.updateOne).not.toHaveBeenCalled();
    });
  });

  describe("injectWorkingMemory", () => {
    it("replaces MEMORY.md with curated snapshot", async () => {
      const memories = [
        {
          category: "preference",
          content: "User prefers dark mode",
          confidence: 0.9,
          active: true,
        },
        { category: "fact", content: "Project uses TypeScript", confidence: 0.8, active: true },
      ];
      const db = mockDb({ memoriesDocs: memories });
      const context = makeContext([makeFile("MEMORY.md", "old memory content")]);

      await injectWorkingMemory(db as any, context, mockApi);

      const memFile = context.bootstrapFiles.find((f) => f.name === "MEMORY.md");
      expect(memFile?.content).toContain("Working Memory (auto-generated from MongoBrain)");
      expect(memFile?.content).toContain("[preference] User prefers dark mode");
      expect(memFile?.content).toContain("[fact] Project uses TypeScript");
      expect(memFile?.missing).toBe(false);
    });

    it("appends MEMORY.md if not present in bootstrapFiles", async () => {
      const memories = [{ category: "note", content: "Something", confidence: 0.7, active: true }];
      const db = mockDb({ memoriesDocs: memories });
      const context = makeContext([makeFile("SOUL.md")]);

      await injectWorkingMemory(db as any, context, mockApi);

      expect(context.bootstrapFiles).toHaveLength(2);
      const memFile = context.bootstrapFiles.find((f) => f.name === "MEMORY.md");
      expect(memFile?.content).toContain("Working Memory");
    });

    it("does nothing when no memories match", async () => {
      const db = mockDb({ memoriesDocs: [] });
      const context = makeContext([makeFile("MEMORY.md", "existing content")]);

      await injectWorkingMemory(db as any, context, mockApi);

      expect(context.bootstrapFiles[0].content).toBe("existing content");
    });

    it("gracefully handles DB errors", async () => {
      const db = {
        getCollection: vi.fn().mockRejectedValue(new Error("connection failed")),
      };
      const context = makeContext([makeFile("MEMORY.md", "existing content")]);

      await injectWorkingMemory(db as any, context, mockApi);

      expect(context.bootstrapFiles[0].content).toBe("existing content");
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("working memory snapshot failed"),
      );
    });
  });

  describe("registerBootstrapHook", () => {
    it("is a noop when dbFirst is false", () => {
      const api = {
        registerHook: vi.fn(),
        on: vi.fn(),
        logger: mockLogger,
      } as any;
      const db = {} as any;
      const cfg = {
        dbFirst: false,
        uri: "",
        database: "",
        agentId: "main",
        autoCapture: true,
        autoRecall: true,
      } as any;

      registerBootstrapHook(api, db, cfg);

      expect(api.registerHook).not.toHaveBeenCalled();
      expect(api.on).not.toHaveBeenCalled();
    });

    it("registers hooks when dbFirst is true", () => {
      const api = {
        registerHook: vi.fn(),
        on: vi.fn(),
        logger: mockLogger,
      } as any;
      const db = {} as any;
      const cfg = {
        dbFirst: true,
        uri: "",
        database: "",
        agentId: "main",
        autoCapture: true,
        autoRecall: true,
      } as any;

      registerBootstrapHook(api, db, cfg);

      expect(api.registerHook).toHaveBeenCalledWith("agent:bootstrap", expect.any(Function), {
        name: "mongobrain-db-first-bootstrap",
      });
      expect(api.on).toHaveBeenCalledWith("before_agent_start", expect.any(Function), {
        priority: 50,
      });
    });
  });
});
