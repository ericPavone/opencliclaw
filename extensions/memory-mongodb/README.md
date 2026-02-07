# @openclaw/memory-mongodb

MongoDB-backed structured knowledge management plugin for OpenClaw. Replaces the default file-based memory system with a persistent MongoDB database organized into 5 specialized collections.

## Features

- **5 Collections**: memories, guidelines, seeds, agent_config, skills
- **Auto-recall**: automatically injects relevant memories into agent context based on conversation content
- **Auto-capture**: detects memorable statements (preferences, decisions, entities) and stores them
- **Agent config injection**: loads soul, identity, persona, instructions from MongoDB at every agent run (both API and CLI agents)
- **CLI workspace bootstrap**: auto-generates TOOLS.md/BOOT.md sections when CLI models (e.g. `claude-cli`) are in config
- **Text search**: MongoDB text indexes across all collections with relevance scoring
- **Migration tools**: migrate from workspace files (SOUL.md, MEMORY.md, daily logs, knowledge/) to MongoDB
- **Agent tools**: `mongobrain_search`, `mongobrain_store`, `mongobrain_get`, `mongobrain_forget`, `mongobrain_skill_match`, `mongobrain_config_load`
- **CLI commands**: `openclaw mongobrain status|search|store|get-config|get-skill|match-skill|export|prune|migrate`
- **TLS support**: optional CA file, cert/key, and allow-invalid-certs

## Setup

### 1. Install

The plugin ships as an OpenClaw extension. Add it to the `plugins.entries` section of `openclaw.json`:

```json
{
  "plugins": {
    "slots": {
      "memory": "memory-mongodb"
    },
    "entries": {
      "memory-mongodb": {
        "enabled": true,
        "config": {
          "uri": "${MONGODB_URI}",
          "database": "openclaw_memory",
          "agentId": "main",
          "autoRecall": true,
          "autoCapture": true
        }
      }
    }
  }
}
```

### 2. Environment

Set `MONGODB_URI` in your environment or `.env`:

```bash
MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/
```

### 3. Verify

```bash
openclaw mongobrain status
```

## Configuration

| Key                     | Type    | Default           | Description                                                 |
| ----------------------- | ------- | ----------------- | ----------------------------------------------------------- |
| `uri`                   | string  | _required_        | MongoDB connection URI (supports `${ENV_VAR}` substitution) |
| `database`              | string  | `openclaw_memory` | Database name                                               |
| `agentId`               | string  | `default`         | Agent ID for scoped config/data                             |
| `autoRecall`            | boolean | `true`            | Auto-inject relevant memories into agent context            |
| `autoCapture`           | boolean | `true`            | Auto-detect and store memorable statements                  |
| `tls.caFile`            | string  | -                 | CA certificate file path                                    |
| `tls.certKeyFile`       | string  | -                 | Client cert/key file path                                   |
| `tls.allowInvalidCerts` | boolean | `false`           | Skip TLS certificate validation                             |

## Collections

### memories

Conversational facts, preferences, decisions, entities. Auto-captured from conversation when `autoCapture` is on.

Fields: `content`, `domain`, `category` (fact/preference/decision/entity/note), `tags`, `summary`, `source`, `confidence`, `expires_at` (TTL)

### guidelines

Behavioral rules with priority and domain scoping. Supports activation/deactivation.

Fields: `title`, `content`, `domain`, `task`, `priority`, `tags`, `active`

### seeds

Reusable knowledge templates and reference data.

Fields: `name` (unique), `description`, `content`, `domain`, `tags`, `dependencies`

### agent_config

Per-agent configuration sections loaded at every agent run. Supports types: `soul`, `user`, `identity`, `tools`, `agents`, `heartbeat`, `bootstrap`, `boot`.

Unique on `(type, agent_id)`. Upserted on store.

### skills

Skill definitions with trigger-based matching.

Fields: `name` (unique), `description`, `prompt_base`, `triggers`, `active`, `guidelines`, `seeds`, `examples`

## Agent Tools

Available to API agents automatically. CLI agents (Claude Code) access via `openclaw mongobrain` CLI commands.

| Tool                     | Description                                            |
| ------------------------ | ------------------------------------------------------ |
| `mongobrain_search`      | Search across one or all collections with text ranking |
| `mongobrain_store`       | Store a document in any collection                     |
| `mongobrain_get`         | Get a specific document by name/type                   |
| `mongobrain_forget`      | Delete or deactivate a document                        |
| `mongobrain_skill_match` | Find active skills matching a trigger keyword          |
| `mongobrain_config_load` | Load all agent config sections (or a specific type)    |

## CLI Commands

```bash
# Connection status + collection counts
openclaw mongobrain status

# Search (single or cross-collection)
openclaw mongobrain search "query"
openclaw mongobrain search "query" --collection memories --domain general --limit 5

# Store
openclaw mongobrain store memories --content "User prefers dark mode" --category preference
openclaw mongobrain store config --type soul --content "You are a helpful assistant"
openclaw mongobrain store skills --name "translator" --content "Translate text" --triggers "traduci,translate"

# Load agent config
openclaw mongobrain get-config
openclaw mongobrain get-config --type soul

# Skill operations
openclaw mongobrain get-skill --name "translator"
openclaw mongobrain match-skill --trigger "traduci"

# Export collection to JSON
openclaw mongobrain export memories
openclaw mongobrain export config --agent-id main

# Prune expired memories
openclaw mongobrain prune
```

## Migration

Migrate from workspace files to MongoDB:

```bash
# Dry-run: see what would be migrated
openclaw mongobrain migrate scan

# Migrate everything
openclaw mongobrain migrate all

# Migrate specific sources
openclaw mongobrain migrate workspace-files    # SOUL.md, TOOLS.md, etc. -> agent_config
openclaw mongobrain migrate knowledge           # knowledge/ dir -> seeds
openclaw mongobrain migrate memory-md           # MEMORY.md -> memories
openclaw mongobrain migrate daily-logs          # memory/*.md daily logs -> memories
openclaw mongobrain migrate seed-starters       # insert starter seeds + skill-builder
```

## Lifecycle Hooks

### `before_agent_start` (priority 10) — Agent Config Injection

Loads all `agent_config` sections for the configured `agentId` and injects them as `<agent-config>` prepended context. Runs for both API and CLI agents.

### `before_agent_start` (default priority) — Auto-Recall

When `autoRecall` is enabled, searches the `memories` collection using the user's prompt and injects up to 3 relevant memories as `<relevant-memories>` prepended context.

### `agent_end` — Auto-Capture

When `autoCapture` is enabled, scans conversation messages for memorable patterns (preferences, decisions, entities, facts) and stores up to 3 per turn.

### `gateway_start` — Workspace Bootstrap

When any CLI model is detected in config (e.g. `claude-cli/opus`), auto-appends MongoBrain sections to TOOLS.md and BOOT.md in all workspace directories. Uses idempotent markers to avoid duplicates.

## Indexes

Created automatically on first connection:

- **memories**: text index on `content+summary+domain`, compound `domain+category`, multikey `tags`, TTL on `expires_at`
- **guidelines**: text index on `title+content+domain`, compound `domain+task+active`, `priority`
- **seeds**: text index on `name+description+content`, unique `name`, `domain`
- **agent_config**: text index on `content`, unique compound `type+agent_id`
- **skills**: text index on `name+description+prompt_base`, unique `name`, multikey `triggers`

## Architecture

```
openclaw.json
  └─ plugins.entries.memory-mongodb.config
       ├─ uri ──────────────────► MongoDB Atlas / self-hosted
       ├─ autoRecall: true       (auto-inject memories)
       └─ autoCapture: true      (auto-store from conversation)

Gateway startup:
  register() → lazy MongoClient init → create indexes
  ├─ registerTool() × 6 (search, store, get, forget, skill_match, config_load)
  ├─ registerCli() → openclaw mongobrain *
  ├─ on("before_agent_start") → inject agent_config + auto-recall
  ├─ on("agent_end") → auto-capture
  └─ on("gateway_start") → workspace bootstrap for CLI agents

Agent run (API):
  before_agent_start hooks fire → context injected → agent sees tools natively

Agent run (CLI, e.g. Claude Code):
  before_agent_start hooks fire → context prepended to prompt
  CLI agent uses `openclaw mongobrain` commands via Bash/exec tool
```
