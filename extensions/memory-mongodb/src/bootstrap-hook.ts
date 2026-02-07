import type { Collection } from "mongodb";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { AgentConfigDoc, AgentConfigType } from "./collections/agent-config.js";
import type { MemoryDoc } from "./collections/memories.js";
import type { SkillDoc } from "./collections/skills.js";
import type { MongoDBConfig } from "./config.js";
import type { MongoMemoryDB } from "./db.js";
import * as agentConfig from "./collections/agent-config.js";

// Minimal types mirrored from core (plugin can't import internal-hooks directly)
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

type HookEvent = {
  type: string;
  action: string;
  context: Record<string, unknown>;
};

// NOTE: if agent_config grows beyond 10 types, consider splitting into
// agent_config (technical config) + agent_context (narrative/prompt content)
export const CONFIG_TYPE_TO_FILE: Record<string, string> = {
  soul: "SOUL.md",
  user: "USER.md",
  identity: "IDENTITY.md",
  tools: "TOOLS.md",
  agents: "AGENTS.md",
  heartbeat: "HEARTBEAT.md",
  bootstrap: "BOOTSTRAP.md",
  boot: "BOOT.md",
};

export const FILE_TO_CONFIG_TYPE: Record<string, AgentConfigType> = Object.fromEntries(
  Object.entries(CONFIG_TYPE_TO_FILE).map(([type, file]) => [file, type as AgentConfigType]),
) as Record<string, AgentConfigType>;

const DB_QUERY_TIMEOUT_MS = 3000;

export async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`DB query timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

function isBootstrapEvent(event: HookEvent): event is HookEvent & { context: BootstrapContext } {
  return (
    event.type === "agent" &&
    event.action === "bootstrap" &&
    typeof (event.context as BootstrapContext).workspaceDir === "string" &&
    Array.isArray((event.context as BootstrapContext).bootstrapFiles)
  );
}

export function registerBootstrapHook(
  api: OpenClawPluginApi,
  db: MongoMemoryDB,
  cfg: MongoDBConfig,
): void {
  if (!cfg.dbFirst) {
    return;
  }

  api.registerHook(
    "agent:bootstrap",
    async (event: HookEvent) => {
      if (!isBootstrapEvent(event)) {
        return;
      }

      const context = event.context as BootstrapContext;
      const agentId = context.agentId ?? cfg.agentId;

      try {
        const col = await db.getCollection("agent_config");
        let docs: AgentConfigDoc[];
        try {
          docs = await withTimeout(agentConfig.getConfig(col, agentId), DB_QUERY_TIMEOUT_MS);
        } catch (err) {
          api.logger.warn(`memory-mongodb: bootstrap DB query failed/timeout: ${String(err)}`);
          return;
        }

        // Auto-migrate: DB empty + disk has content → seed DB from workspace files
        if (docs.length === 0) {
          const filesWithContent = context.bootstrapFiles.filter(
            (f) => !f.missing && f.content && f.content.trim().length > 0,
          );
          if (filesWithContent.length > 0) {
            await autoMigrate(col, filesWithContent, agentId, api);
            try {
              docs = await withTimeout(agentConfig.getConfig(col, agentId), DB_QUERY_TIMEOUT_MS);
            } catch {
              return;
            }
          }
        }

        // Per-file merge: replace only files that have a DB counterpart
        if (docs.length > 0) {
          replaceBootstrapFiles(context, docs);
        }

        // MEMORY.md working memory snapshot
        await injectWorkingMemory(db, context, api);
      } catch (err) {
        api.logger.warn(`memory-mongodb: bootstrap hook error: ${String(err)}`);
      }
    },
    { name: "mongobrain-db-first-bootstrap" },
  );

  // Skill-driven context injection (soft guidance)
  api.on(
    "before_agent_start",
    async (event) => {
      if (!event.prompt || event.prompt.length < 5) {
        return;
      }

      try {
        const col = await db.getCollection("skills");
        const allActive = await withTimeout(
          col.find({ active: true, triggers: { $exists: true, $ne: [] } }).toArray() as Promise<
            SkillDoc[]
          >,
          DB_QUERY_TIMEOUT_MS,
        );

        if (allActive.length === 0) {
          return;
        }

        const promptLower = event.prompt.toLowerCase();
        const matched = allActive.filter((s) =>
          s.triggers.some((t) => promptLower.includes(t.toLowerCase())),
        );

        if (matched.length === 0) {
          return;
        }

        const topSkills = matched.slice(0, 3);
        const blocks = topSkills.map((s) => `## Skill: ${s.name}\n${s.prompt_base}`).join("\n\n");

        return {
          prependContext: `<active-skills hint="soft-guidance, not routing">\n${blocks}\n</active-skills>`,
        };
      } catch (err) {
        api.logger.warn(`memory-mongodb: skill injection failed: ${String(err)}`);
      }
    },
    { priority: 50 },
  );
}

export async function autoMigrate(
  col: Collection,
  files: Array<{ name: string; content?: string }>,
  agentId: string,
  api: OpenClawPluginApi,
): Promise<void> {
  let migrated = 0;
  for (const file of files) {
    const configType = FILE_TO_CONFIG_TYPE[file.name];
    if (!configType || !file.content) {
      continue;
    }

    await agentConfig.store(col, {
      type: configType,
      agentId,
      content: file.content,
    });
    migrated++;
  }

  if (migrated > 0) {
    api.logger.info(`memory-mongodb: auto-migrated ${migrated} workspace files to DB (first boot)`);
  }
}

export function replaceBootstrapFiles(context: BootstrapContext, docs: AgentConfigDoc[]): void {
  const docsByFile = new Map<string, AgentConfigDoc>();
  for (const doc of docs) {
    const filename = CONFIG_TYPE_TO_FILE[doc.type];
    if (filename) {
      docsByFile.set(filename, doc);
    }
  }

  for (const entry of context.bootstrapFiles) {
    const doc = docsByFile.get(entry.name);
    if (doc) {
      entry.content = doc.content;
      entry.missing = false;
      docsByFile.delete(entry.name);
    }
  }

  // Append DB docs that have no matching disk file
  for (const [filename, doc] of docsByFile) {
    context.bootstrapFiles.push({
      name: filename,
      path: `db://${doc.type}`,
      content: doc.content,
      missing: false,
    });
  }
}

export async function injectWorkingMemory(
  db: MongoMemoryDB,
  context: BootstrapContext,
  api: OpenClawPluginApi,
): Promise<void> {
  try {
    const col = await db.getCollection("memories");
    const docs = await withTimeout(
      col
        .find({ confidence: { $gte: 0.7 }, active: { $ne: false } })
        .sort({ updated_at: -1 })
        .limit(15)
        .toArray() as Promise<MemoryDoc[]>,
      DB_QUERY_TIMEOUT_MS,
    );

    if (docs.length === 0) {
      return;
    }

    const lines = docs.map((d) => `- [${d.category}] ${d.content}`);
    const snapshot = `# Working Memory (auto-generated from MongoBrain)\n\n${lines.join("\n")}`;

    const memoryEntry = context.bootstrapFiles.find(
      (f) => f.name === "MEMORY.md" || f.name === "memory.md",
    );
    if (memoryEntry) {
      memoryEntry.content = snapshot;
      memoryEntry.missing = false;
    } else {
      context.bootstrapFiles.push({
        name: "MEMORY.md",
        path: "db://working-memory",
        content: snapshot,
        missing: false,
      });
    }
  } catch (err) {
    api.logger.warn(`memory-mongodb: working memory snapshot failed: ${String(err)}`);
  }
}
