import { readFileSync, existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename, relative } from "node:path";
import type { AgentConfigType } from "./collections/agent-config.js";
import type { MongoMemoryDB } from "./db.js";

const DEFAULT_WORKSPACE = join(homedir(), ".openclaw", "workspace");

const DATE_SLUG_RE = /^(\d{4}-\d{2}-\d{2})(?:-(.+))?\.md$/;

const WORKSPACE_FILES: Array<[string, string, AgentConfigType]> = [
  ["SOUL.md", "Agent personality and behavioral guidelines", "soul"],
  ["USER.md", "User-specific context and preferences", "user"],
  ["IDENTITY.md", "Agent identity, name, branding", "identity"],
  ["TOOLS.md", "Custom tool instructions and usage", "tools"],
  ["AGENTS.md", "Agent definitions, routing rules, personas", "agents"],
  ["HEARTBEAT.md", "Scheduled heartbeat instructions", "heartbeat"],
  ["BOOTSTRAP.md", "Initial workspace setup instructions", "bootstrap"],
  ["BOOT.md", "Executed on gateway startup via boot-md hook", "boot"],
];

const BOOT_MARKER = "<!-- mongoBrain:seed-boot -->";
const BOOT_SEED = `${BOOT_MARKER}
## mongoBrain — Identity Recovery

All'avvio, carica la configurazione completa dal database usando lo strumento
\`mongobrain_config_load\`.

Applica ogni sezione (soul, identity, user, tools, agents, heartbeat, bootstrap)
come contesto operativo per questa sessione.

Poi carica l'indice delle skill attive:

Usa \`mongobrain_search\` con collection "skills" per cercare le skill attive.

Se una sezione non e' presente nel database, ignorala e prosegui.

### Creare nuove skill

Per creare una nuova skill, usa \`mongobrain_skill_match\` con trigger "create skill".
Poi carica la skill-builder con \`mongobrain_get\` collection "skills" name "skill-builder".

Segui le guidelines della skill-builder per compilare ogni sezione del documento.
`;

// ============================================================================
// Helpers
// ============================================================================

function resolveWorkspace(workspace?: string): string {
  const ws = workspace ? join(workspace.replace(/^~/, homedir()), "") : DEFAULT_WORKSPACE;
  if (!existsSync(ws) || !statSync(ws).isDirectory()) {
    throw new Error(`Workspace not found: ${ws}`);
  }
  return ws;
}

function parseSections(text: string): Array<{ heading: string; body: string }> {
  const entries: Array<{ heading: string; body: string }> = [];
  const lines = text.split("\n");
  let currentHeading = "";
  let currentBody: string[] = [];

  for (const line of lines) {
    const match = /^#{1,3}\s+(.+)$/.exec(line);
    if (match) {
      if (currentHeading && currentBody.length > 0) {
        entries.push({ heading: currentHeading, body: currentBody.join("\n").trim() });
      }
      currentHeading = match[1].trim();
      currentBody = [];
    } else {
      currentBody.push(line);
    }
  }

  if (currentHeading && currentBody.length > 0) {
    entries.push({ heading: currentHeading, body: currentBody.join("\n").trim() });
  }

  if (entries.length === 0 && text.trim()) {
    entries.push({ heading: "", body: text.trim() });
  }

  return entries;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

function readTextFile(path: string): string {
  return readFileSync(path, "utf-8").trim();
}

function listMdFiles(dir: string): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => join(dir, f));
}

function listSubDirs(dir: string): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir)
    .map((d) => join(dir, d))
    .filter((d) => statSync(d).isDirectory())
    .sort();
}

function listMdFilesRecursive(dir: string): string[] {
  const results: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...listMdFilesRecursive(full));
    } else if (entry.name.endsWith(".md")) {
      results.push(full);
    }
  }
  return results.sort();
}

// ============================================================================
// Migrator
// ============================================================================

type MigrateResult = {
  migrated: number;
  skipped: number;
  source: string;
  type: string;
};

export function createMigrator(db: MongoMemoryDB, agentId: string) {
  async function insertMemory(
    content: string,
    category: string,
    domain: string,
    tags: string[],
    source: string,
    summary: string,
    confidence: number,
  ): Promise<boolean> {
    content = content.trim();
    if (!content || content.length < 10) return false;

    const col = await db.getCollection("memories");
    const existing = await col.findOne({ content, domain });
    if (existing) return false;

    const now = new Date();
    await col.insertOne({
      content,
      summary,
      domain,
      category,
      tags,
      confidence,
      source,
      embedding_text: `${content} ${summary}`.trim(),
      active: true,
      version: 1,
      expires_at: null,
      created_at: now,
      updated_at: now,
    });
    return true;
  }

  async function insertSeed(
    name: string,
    description: string,
    content: string,
    domain: string,
    tags: string[],
  ): Promise<boolean> {
    content = content.trim();
    if (!content || content.length < 10) return false;

    const col = await db.getCollection("seeds");
    const existing = await col.findOne({ name });
    if (existing) return false;

    const now = new Date();
    await col.insertOne({
      name,
      description,
      content,
      domain,
      tags,
      dependencies: [],
      version: 1,
      author: "migrate",
      created_at: now,
      updated_at: now,
    });
    return true;
  }

  return {
    async migrateWorkspaceFiles(
      workspace?: string,
    ): Promise<MigrateResult & { upserted: number; updated: number }> {
      const ws = resolveWorkspace(workspace);
      const col = await db.getCollection("agent_config");
      const now = new Date();
      let upserted = 0;
      let updated = 0;
      let skipped = 0;

      for (const [filename, , slug] of WORKSPACE_FILES) {
        const filepath = join(ws, filename);
        if (!existsSync(filepath)) continue;

        const text = readTextFile(filepath);
        if (!text || text.length < 10) {
          skipped++;
          continue;
        }

        const filter = { type: slug, agent_id: agentId };
        const update = {
          $set: { content: text, updated_at: now },
          $setOnInsert: { type: slug, agent_id: agentId, version: 1, created_at: now },
        };
        const r = await col.updateOne(filter, update, { upsert: true });
        if (r.upsertedId) upserted++;
        else if (r.modifiedCount) updated++;
        else skipped++;
      }

      return {
        migrated: upserted + updated,
        skipped,
        upserted,
        updated,
        source: ws,
        type: "workspace-files",
      };
    },

    async migrateKnowledge(workspace?: string): Promise<MigrateResult> {
      const ws = resolveWorkspace(workspace);
      const knowledgeDir = join(ws, "knowledge");
      const files = listMdFiles(knowledgeDir);
      let migrated = 0;
      let skipped = 0;

      for (const filepath of files) {
        const text = readTextFile(filepath);
        const slug = slugify(basename(filepath, ".md"));
        const name = `knowledge-${slug}`;
        if (
          await insertSeed(
            name,
            `Knowledge base: ${basename(filepath, ".md")}`,
            text,
            "openclaw-knowledge",
            ["migrated", "knowledge", slug],
          )
        ) {
          migrated++;
        } else {
          skipped++;
        }
      }

      return { migrated, skipped, source: knowledgeDir, type: "knowledge" };
    },

    async migrateTemplates(workspace?: string): Promise<MigrateResult> {
      const ws = resolveWorkspace(workspace);
      const templatesDir = join(ws, "templates");
      const files = listMdFiles(templatesDir);
      let migrated = 0;
      let skipped = 0;

      for (const filepath of files) {
        const text = readTextFile(filepath);
        const slug = slugify(basename(filepath, ".md"));
        const name = `template-${slug}`;
        if (
          await insertSeed(
            name,
            `Template: ${basename(filepath, ".md")}`,
            text,
            "openclaw-templates",
            ["migrated", "template", slug],
          )
        ) {
          migrated++;
        } else {
          skipped++;
        }
      }

      return { migrated, skipped, source: templatesDir, type: "templates" };
    },

    async migrateProjects(workspace?: string): Promise<MigrateResult> {
      const ws = resolveWorkspace(workspace);
      const projectsDir = join(ws, "projects");
      const dirs = listSubDirs(projectsDir);
      let migrated = 0;
      let skipped = 0;

      for (const projectDir of dirs) {
        const mdFiles = listMdFilesRecursive(projectDir);
        if (mdFiles.length === 0) continue;

        const parts: string[] = [];
        for (const md of mdFiles) {
          const text = readTextFile(md).trim();
          if (text) {
            parts.push(`# ${relative(projectDir, md)}\n\n${text}`);
          }
        }

        if (parts.length === 0) continue;

        const slug = slugify(basename(projectDir));
        const content = parts.join("\n\n---\n\n");
        const name = `project-${slug}`;
        const desc = `Project specs: ${basename(projectDir)} (${mdFiles.length} files)`;

        if (
          await insertSeed(name, desc, content, "openclaw-projects", ["migrated", "project", slug])
        ) {
          migrated++;
        } else {
          skipped++;
        }
      }

      return { migrated, skipped, source: projectsDir, type: "projects" };
    },

    async migrateMemoryMd(workspace?: string, domain?: string): Promise<MigrateResult> {
      const ws = resolveWorkspace(workspace);
      const memoryFile = join(ws, "MEMORY.md");
      if (!existsSync(memoryFile)) {
        return { migrated: 0, skipped: 0, source: memoryFile, type: "memory-md" };
      }

      const text = readTextFile(memoryFile);
      const entries = parseSections(text);
      const targetDomain = domain ?? "openclaw-memory";
      let migrated = 0;
      let skipped = 0;

      for (const entry of entries) {
        if (
          await insertMemory(
            entry.body,
            "note",
            targetDomain,
            ["migrated", "memory-md"],
            "import",
            entry.heading,
            0.9,
          )
        ) {
          migrated++;
        } else {
          skipped++;
        }
      }

      return { migrated, skipped, source: memoryFile, type: "memory-md" };
    },

    async migrateDailyLogs(
      workspace?: string,
      domain?: string,
    ): Promise<MigrateResult & { files: number }> {
      const ws = resolveWorkspace(workspace);
      const memoryDir = join(ws, "memory");
      const logFiles = listMdFiles(memoryDir);
      const targetDomain = domain ?? "openclaw-daily";
      let migrated = 0;
      let skipped = 0;

      for (const logFile of logFiles) {
        const text = readTextFile(logFile);
        const sections = parseSections(text);
        const dateMatch = DATE_SLUG_RE.exec(basename(logFile));
        const dateStr = dateMatch ? dateMatch[1] : basename(logFile, ".md");
        const slug = dateMatch?.[2] ?? "";

        for (const section of sections) {
          const tags = ["migrated", "daily-log", `date:${dateStr}`];
          if (slug) tags.push(`session:${slug}`);
          const summary = `[${dateStr}] ${section.heading}`;

          if (
            await insertMemory(section.body, "note", targetDomain, tags, "import", summary, 0.75)
          ) {
            migrated++;
          } else {
            skipped++;
          }
        }
      }

      return { migrated, skipped, files: logFiles.length, source: memoryDir, type: "daily-logs" };
    },

    async seedStarters(): Promise<{
      seeds: { inserted: number; skipped: number };
      skills: { inserted: number; skipped: number };
    }> {
      const now = new Date();
      const seedsCol = await db.getCollection("seeds");
      const skillsCol = await db.getCollection("skills");

      // Starter seeds
      const starterSeeds = [
        {
          name: "mongoBrain-usage",
          description: "How to use mongoBrain to persist agent knowledge",
          content:
            "mongoBrain stores data across 5 collections:\n" +
            "1. memories — facts, preferences, notes learned from conversations\n" +
            "2. guidelines — SOPs, checklists, best practices per domain/task\n" +
            "3. seeds — portable knowledge packages transferable between agents\n" +
            "4. agent_config — agent identity sections (soul, tools, identity, etc.)\n" +
            "5. skills — self-contained skill bundles with guidelines, seeds, tools, examples\n\n" +
            "Use the mongobrain_* tools or the `openclaw mongobrain` CLI to store, search, export, import, prune, and deactivate entries.",
          domain: "openclaw",
          tags: ["mongoBrain", "memory", "getting-started"],
          dependencies: [],
          version: 1,
          author: "mongoBrain",
          created_at: now,
          updated_at: now,
        },
        {
          name: "skill-creation-wizard",
          description:
            "Quick reference for creating mongoBrain skills — points to the full skill-builder skill",
          content:
            "To create a new mongoBrain skill, activate the skill-builder:\n\n" +
            "  Use mongobrain_skill_match with trigger 'create skill'\n" +
            "  Use mongobrain_get collection 'skills' name 'skill-builder'\n\n" +
            "The skill-builder walks you through 9 steps:\n" +
            "1. Briefing & Discovery\n" +
            "2. Identity & Metadata (name, triggers, depends_on)\n" +
            "3. Prompt Base Composition (role, methodology, behavior)\n" +
            "4. Guidelines Authoring (workflow steps with priority + agent delegation)\n" +
            "5. Seeds Authoring (embedded knowledge)\n" +
            "6. Tools Definition (CLI, MCP, API, manual)\n" +
            "7. Examples Creation (usage scenarios)\n" +
            "8. References (documentation links)\n" +
            "9. Assembly, Validation & Save\n\n" +
            "Each step collects information, validates it, and shows a preview.\n" +
            "The final step produces a ready-to-use skill in the database.",
          domain: "openclaw",
          tags: ["mongoBrain", "skill", "wizard", "creation"],
          dependencies: ["mongoBrain-usage"],
          version: 1,
          author: "mongoBrain",
          created_at: now,
          updated_at: now,
        },
      ];

      let seedsInserted = 0;
      let seedsSkipped = 0;
      for (const seed of starterSeeds) {
        const existing = await seedsCol.findOne({ name: seed.name });
        if (existing) {
          seedsSkipped++;
        } else {
          await seedsCol.insertOne(seed);
          seedsInserted++;
        }
      }

      // Skill-builder skill
      const skillBuilderData: Record<string, unknown> = {
        name: "skill-builder",
        description:
          "Guided wizard to create, populate and validate mongoBrain skills step by step, covering every section of the document",
        version: 1,
        prompt_base:
          "You are a skill architect for mongoBrain. Guide the user through creating a complete, well-structured skill document. Work one section at a time: collect information, validate it, show a preview, then move to the next. Never skip a section without asking. When a section is optional and the user has nothing to add, confirm and move on. Output the final skill as a JSON file ready for import.",
        triggers: [
          "create skill",
          "new skill",
          "build skill",
          "skill builder",
          "crea skill",
          "nuova skill",
          "aggiungi skill",
        ],
        depends_on: [],
        guidelines: [
          {
            title: "Briefing & Discovery",
            content:
              "1. Ask what skill the user wants to create\n2. Understand the domain and target audience\n3. Identify the problem this skill solves\n4. Map the expected workflow at a high level (which phases?)\n5. Confirm understanding before proceeding\n\nOutput: summary of what the skill will do and who it targets.",
            task: "briefing",
            priority: 10,
            domain: "skill-building",
            tags: ["briefing", "discovery", "requirements"],
          },
          {
            title: "Identity & Metadata",
            content:
              "Collect from the user:\n1. name — kebab-case identifier (e.g. 'code-review', 'api-documentation')\n   Validate uniqueness: mongobrain_get collection 'skills' name <name> must return 'not found'\n2. description — one clear sentence explaining what the skill does\n3. version — start at 1\n4. triggers — 3-5 phrases that should activate this skill\n   Include synonyms, abbreviations, bilingual variants if relevant\n   Validate: mongobrain_search collection 'skills' query <trigger> must not match unrelated skills\n5. depends_on — list of other skill names required (empty array if none)\n\nShow a preview of the identity block and confirm before proceeding.",
            task: "identity",
            priority: 9,
            domain: "skill-building",
            tags: ["metadata", "naming", "triggers"],
          },
          {
            title: "Prompt Base Composition",
            content:
              "Build the prompt_base string by collecting three elements:\n\n1. ROLE — what expert persona should the agent adopt?\n   'You are a [role] specialized in [domain]'\n2. METHODOLOGY — what approach or framework to follow?\n   'Follow [methodology/standard]. Reference [sources] when relevant.'\n3. BEHAVIOR — how should the agent interact?\n   'Ask clarifying questions before proceeding. Work step by step.'\n\nCompose into a single coherent paragraph, max 500 characters.\nThe prompt_base sets the agent's mindset for the entire skill execution.\nDo NOT include instructions that belong in guidelines — keep the prompt_base about identity and approach, not about specific steps.\n\nShow the composed prompt_base and confirm.",
            task: "prompt-base",
            priority: 9,
            domain: "skill-building",
            tags: ["prompt", "role", "behavior"],
          },
          {
            title: "Guidelines Authoring",
            content:
              "For each phase of the skill workflow, create a guideline.\nCollect at least 2 guidelines. Walk through each one:\n\nRequired fields:\n- title: clear name for this step\n- content: numbered list of instructions the agent must follow\n- task: kebab-case phase identifier\n- priority: 1-10. Convention: planning=10, core work=8-9, review/QA=7\n- domain: consistent across all guidelines in the skill\n- tags: relevant keywords for searchability\n\nOptional fields:\n- input_format: what this step expects as input\n- output_format: what this step produces\n\nAfter each guideline, show a preview and ask if the user wants to add another.\nWhen done, show the full guidelines list sorted by priority descending.",
            task: "guidelines",
            priority: 8,
            domain: "skill-building",
            tags: ["guidelines", "workflow", "steps"],
          },
          {
            title: "Seeds Authoring",
            content:
              "Ask: does this skill require embedded knowledge the agent must reference during execution?\n\nIf yes, for each seed collect:\n- name: unique kebab-case identifier within this skill\n- description: what knowledge this contains\n- content: the actual reference material\n- domain: same as skill domain\n- tags: keywords\n- dependencies: other seed names this builds upon (default: [])\n- author: who created this knowledge\n- version: 1\n\nKey distinction: seeds are DECLARATIVE KNOWLEDGE ('what to know'), not PROCEDURES ('what to do').\nGuidelines tell the agent what to do. Seeds give the agent reference material to do it well.\n\nIf the user has nothing to add, confirm and move on with empty seeds array.",
            task: "seeds",
            priority: 7,
            domain: "skill-building",
            tags: ["seeds", "knowledge", "reference"],
          },
          {
            title: "Tools Definition",
            content:
              "Ask: does this skill require external tools the agent can invoke?\n\nFor each tool collect:\n- name: kebab-case identifier\n- description: what the tool does\n- command: the actual command string or tool name\n- type: 'cli' | 'mcp' | 'api' | 'manual'\n\nIf the user has no tools to add, confirm and move on with empty tools array.",
            task: "tools",
            priority: 7,
            domain: "skill-building",
            tags: ["tools", "cli", "mcp", "api"],
          },
          {
            title: "Examples Creation",
            content:
              "Ask for 1-3 realistic usage scenarios.\n\nFor each example collect:\n- input: what the user would say to trigger and use this skill\n- output: summary of what the agent would produce\n- description: brief label for this scenario\n\nIf the user has no examples, confirm and move on with empty examples array.",
            task: "examples",
            priority: 6,
            domain: "skill-building",
            tags: ["examples", "scenarios", "usage"],
          },
          {
            title: "References",
            content:
              "Ask: are there reference URLs the agent should consult?\n\nFor each reference collect:\n- url: full URL\n- title: document title\n- description: what information this provides\n\nIf the user has no references, confirm and move on with empty references array.",
            task: "references",
            priority: 6,
            domain: "skill-building",
            tags: ["references", "documentation", "links"],
          },
          {
            title: "Assembly, Validation & Save",
            content:
              "1. Assemble the complete JSON document with all sections collected\n2. Show the full document to the user for final review\n3. Validate:\n   a. name is unique (mongobrain_get collection 'skills' name <name> should return 'not found')\n   b. All required fields present (name, description, prompt_base, triggers, guidelines)\n   c. At least 2 guidelines with valid priority ordering\n   d. Triggers don't overlap with existing skills (mongobrain_search collection 'skills' query <trigger>)\n   e. JSON is valid and well-formed\n4. Ask the user to confirm or request changes\n5. Save using mongobrain_store collection 'skills'\n6. Verify:\n   a. mongobrain_get collection 'skills' name <skill-name> — returns the full document\n   b. mongobrain_skill_match trigger <one-of-the-triggers> — finds this skill\n7. Report success with a summary of what was created.",
            task: "save",
            priority: 10,
            domain: "skill-building",
            tags: ["assembly", "validation", "import", "verify"],
          },
        ],
        seeds: [
          {
            name: "skill-document-schema",
            description: "Complete schema reference for every field in a mongoBrain skill document",
            content:
              "SKILL DOCUMENT — FIELD REFERENCE\n\nTOP-LEVEL:\n  name: string, required, unique, kebab-case\n  description: string, required, one sentence\n  version: integer, default 1\n  prompt_base: string, behavioral prompt for the agent persona\n  triggers: string[], activation phrases\n  depends_on: string[], other skill names required\n  guidelines: Guideline[], workflow steps (min 2)\n  seeds: Seed[], embedded knowledge\n  tools: Tool[], external tools\n  examples: Example[], usage scenarios\n  references: Reference[], documentation links\n  active: boolean, default true\n\nGUIDELINE:\n  title: string, required\n  content: string, required, numbered instructions\n  task: string, required, phase identifier (kebab-case)\n  priority: integer, required, 1-10 (higher = first)\n  domain: string, same as skill domain\n  tags: string[]\n  input_format: string, optional\n  output_format: string, optional\n\nSEED:\n  name: string, required, unique within skill\n  description: string, required\n  content: string, required, the knowledge itself\n  domain: string, default same as skill domain\n  tags: string[]\n  dependencies: string[], other seed names\n  author: string\n  version: integer, default 1\n\nTOOL:\n  name: string, required\n  description: string, required\n  command: string, required\n  type: 'cli' | 'mcp' | 'api' | 'manual'\n\nEXAMPLE:\n  input: string, what user says\n  output: string, what agent produces\n  description: string, scenario label\n\nREFERENCE:\n  url: string, full URL\n  title: string, document title\n  description: string, what it provides",
            domain: "skill-building",
            tags: ["schema", "reference", "fields"],
            dependencies: [],
            author: "mongoBrain",
            version: 1,
          },
          {
            name: "skill-design-patterns",
            description: "Best practices and anti-patterns for designing effective skills",
            content:
              "SKILL DESIGN PATTERNS\n\nNAMING:\n- kebab-case: 'code-review', 'api-documentation'\n- Be specific: 'k8s-cluster-setup' not 'kubernetes'\n- Avoid generic: 'helper', 'utils', 'misc'\n\nTRIGGERS:\n- 3-5 variations (synonyms, abbreviations, bilingual)\n- Specific enough to avoid false matches\n- Test: would this trigger ONLY match this skill?\n\nPRIORITY CONVENTION:\n  10 = briefing/planning and final save\n  9  = core identity and methodology steps\n  8  = implementation and execution\n  7  = review, QA, validation\n  6  = optional enrichment (examples, references)\n\nGUIDELINES vs SEEDS:\n- Guideline = 'what to DO' (procedure, numbered steps)\n- Seed = 'what to KNOW' (reference material, patterns)\n- If it changes between executions -> guideline\n- If it's always the same knowledge -> seed\n\nANTI-PATTERNS:\n- Skill with 1 guideline (too coarse, split into steps)\n- Seed that's actually a procedure (move to guideline)\n- Generic triggers that match everything\n- prompt_base with step-by-step instructions (those go in guidelines)",
            domain: "skill-building",
            tags: ["patterns", "best-practices", "design", "anti-patterns"],
            dependencies: ["skill-document-schema"],
            author: "mongoBrain",
            version: 1,
          },
        ],
        tools: [
          {
            name: "check-name-unique",
            type: "tool",
            command: "mongobrain_get collection 'skills' name <skill-name>",
            description:
              "Check if a skill name is already taken (expect 'not found' for new skills)",
          },
          {
            name: "check-trigger-overlap",
            type: "tool",
            command: "mongobrain_search collection 'skills' query <trigger>",
            description: "Check if a trigger overlaps with existing skills",
          },
          {
            name: "save-skill",
            type: "tool",
            command: "mongobrain_store collection 'skills'",
            description: "Store the assembled skill into MongoDB",
          },
          {
            name: "verify-skill",
            type: "tool",
            command: "mongobrain_get collection 'skills' name <skill-name>",
            description: "Verify the skill was stored correctly",
          },
          {
            name: "verify-trigger",
            type: "tool",
            command: "mongobrain_skill_match trigger <trigger>",
            description: "Verify a trigger activates the correct skill",
          },
        ],
        examples: [
          {
            input: "Crea una skill per fare code review strutturate",
            output:
              "1. Briefing: skill per code review con checklist, target dev team\n2. Identity: name 'code-review', triggers ['review', 'code review', 'PR review']\n3. Prompt base: 'You are a senior code reviewer...'\n4. Guidelines: preparation (10), code analysis (9), feedback writing (8), approval flow (7)\n5. Seeds: review-checklist patterns, common code smells\n6. Tools: git diff, gh pr view\n7. Examples: 2 review scenarios\n8. Import, verify, done",
            description: "Code review skill creation",
          },
          {
            input: "Build a skill for API documentation generation",
            output:
              "1. Briefing: auto-generate OpenAPI docs, target backend devs\n2. Identity: name 'api-docs-generator', triggers ['api docs', 'generate docs', 'openapi']\n3. Prompt base: 'You are an API documentation specialist...'\n4. Guidelines: endpoint discovery (10), schema extraction (9), doc writing (8), validation (7)\n5. Seeds: openapi-schema-reference, doc-writing-patterns\n6. Tools: swagger-cli validate, redocly lint\n7. Examples: REST API docs, GraphQL schema docs\n8. Import, verify, done",
            description: "API documentation skill creation",
          },
        ],
        references: [],
        active: true,
      };

      let skillsInserted = 0;
      let skillsSkipped = 0;
      const existingSkill = await skillsCol.findOne({ name: skillBuilderData.name });
      if (existingSkill) {
        // Update existing
        await skillsCol.updateOne(
          { name: skillBuilderData.name },
          { $set: { ...skillBuilderData, updated_at: now }, $setOnInsert: { created_at: now } },
          { upsert: true },
        );
        skillsSkipped++;
      } else {
        await skillsCol.insertOne({ ...skillBuilderData, created_at: now, updated_at: now });
        skillsInserted++;
      }

      return {
        seeds: { inserted: seedsInserted, skipped: seedsSkipped },
        skills: { inserted: skillsInserted, skipped: skillsSkipped },
      };
    },

    async seedBoot(workspace?: string): Promise<{ action: string; file: string }> {
      const ws = resolveWorkspace(workspace);
      const bootFile = join(ws, "BOOT.md");

      if (existsSync(bootFile)) {
        const existing = readTextFile(bootFile);
        if (existing.includes(BOOT_MARKER)) {
          return { action: "skipped", file: bootFile };
        }
        writeFileSync(bootFile, `${existing}\n\n${BOOT_SEED}`, "utf-8");
        return { action: "appended", file: bootFile };
      }

      writeFileSync(bootFile, `# Boot\n\n${BOOT_SEED}`, "utf-8");
      return { action: "created", file: bootFile };
    },

    async migrateAll(workspace?: string, domain?: string): Promise<Record<string, unknown>> {
      const ws = resolveWorkspace(workspace);
      const results: Record<string, unknown> = {};

      results.workspaceFiles = await this.migrateWorkspaceFiles(workspace);

      if (existsSync(join(ws, "knowledge")) && statSync(join(ws, "knowledge")).isDirectory()) {
        results.knowledge = await this.migrateKnowledge(workspace);
      }

      if (existsSync(join(ws, "templates")) && statSync(join(ws, "templates")).isDirectory()) {
        results.templates = await this.migrateTemplates(workspace);
      }

      if (existsSync(join(ws, "projects")) && statSync(join(ws, "projects")).isDirectory()) {
        results.projects = await this.migrateProjects(workspace);
      }

      if (existsSync(join(ws, "MEMORY.md"))) {
        results.memoryMd = await this.migrateMemoryMd(workspace, domain);
      }

      const memoryDir = join(ws, "memory");
      if (existsSync(memoryDir) && listMdFiles(memoryDir).length > 0) {
        results.dailyLogs = await this.migrateDailyLogs(workspace, domain);
      }

      results.starters = await this.seedStarters();
      results.seedBoot = await this.seedBoot(workspace);

      return results;
    },

    async scan(workspace?: string): Promise<Record<string, unknown>> {
      const ws = resolveWorkspace(workspace);
      const report: Record<string, unknown> = { workspace: ws, found: {} };
      const found: Record<string, unknown> = {};

      // Workspace files
      const wsFound: Array<{ file: string; description: string; bytes: number }> = [];
      for (const [filename, description] of WORKSPACE_FILES) {
        const filepath = join(ws, filename);
        if (existsSync(filepath)) {
          wsFound.push({ file: filename, description, bytes: statSync(filepath).size });
        }
      }
      if (wsFound.length > 0) found.workspace_files = wsFound;

      // Knowledge
      const knowledgeDir = join(ws, "knowledge");
      const knowledgeFiles = listMdFiles(knowledgeDir).map((f) => basename(f));
      if (knowledgeFiles.length > 0) found.knowledge = knowledgeFiles;

      // Templates
      const templatesDir = join(ws, "templates");
      const templateFiles = listMdFiles(templatesDir).map((f) => basename(f));
      if (templateFiles.length > 0) found.templates = templateFiles;

      // Projects
      const projectsDir = join(ws, "projects");
      const projectDirs = listSubDirs(projectsDir);
      const projects: Array<{ project: string; files: string[] }> = [];
      for (const pd of projectDirs) {
        const mdFiles = listMdFilesRecursive(pd).map((f) => basename(f));
        if (mdFiles.length > 0) {
          projects.push({ project: basename(pd), files: mdFiles });
        }
      }
      if (projects.length > 0) found.projects = projects;

      // MEMORY.md
      const memoryFile = join(ws, "MEMORY.md");
      if (existsSync(memoryFile)) {
        const entries = parseSections(readTextFile(memoryFile));
        found["MEMORY.md"] = {
          sections: entries.length,
          headings: entries.map((e) => e.heading),
        };
      }

      // Daily logs
      const memoryDir = join(ws, "memory");
      const logFiles = listMdFiles(memoryDir);
      if (logFiles.length > 0) {
        let totalEntries = 0;
        const details: Array<{ file: string; entries: number }> = [];
        for (const lf of logFiles) {
          const entries = parseSections(readTextFile(lf));
          totalEntries += entries.length;
          details.push({ file: basename(lf), entries: entries.length });
        }
        found.daily_logs = { files: logFiles.length, total_entries: totalEntries, details };
      }

      report.found = found;
      return report;
    },
  };
}
