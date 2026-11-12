# Master Brain MCP Hub

> MCP server that connects AI coding tools to the Master Brain backend.  
> Auto-Memory is **explicit**: call `brain_observe` from hooks or the agent — stdio MCP cannot passively observe the full conversation.

**Version:** 1.1.0  
**Status:** In Development

## Features

- **Brain tools** — search / save / stats / recent / health against the Brain API
- **Explicit Auto-Memory** — `brain_observe` runs Haiku importance analysis and persists high-confidence items
- **Structured errors** — stable `{ code, message, details? }` on every failure path
- **Zod validation** at the MCP tool boundary
- **SHA-256 deduplication** with SQLite-backed persistence (in-memory fallback only where explicitly permitted)
- **Contracts-first** — `CONTRACTS/api_contract.md` matches `src/brain/client.ts`

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                   MCP MASTER BRAIN HUB                      │
│  tools: search | save | recent | stats | health | observe   │
│                         │                                   │
│              brain_observe ──▶ Auto-Memory Middleware       │
│                         │         │                         │
│                         │    Haiku analysis + SHA-256 dedup │
│                         ▼         ▼                         │
│                   BrainClient (HTTP)                        │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
                    Master Brain Backend
                 (BRAIN_API_URL — not this repo)
```

## Quick Start

```bash
git clone <your-fork-or-upstream>
cd Master-Brain-MCP-Hub
npm install
cp .env.example .env
# set BRAIN_API_URL, ANTHROPIC_API_KEY
npm run build
npm start
```

### Claude Code MCP config (example)

```json
{
  "master-brain": {
    "type": "stdio",
    "command": "node",
    "args": ["/absolute/path/to/Master-Brain-MCP-Hub/dist/index.js"],
    "env": {
      "BRAIN_API_URL": "http://localhost:3001",
      "ANTHROPIC_API_KEY": "sk-ant-xxxxx"
    }
  }
}
```

Do **not** embed production hostnames or secrets in tracked files.

## MCP Tools

| Tool | Description |
|------|-------------|
| `brain_search` | Hybrid / semantic / keyword search |
| `brain_save` | Manual persistence |
| `brain_stats` | Aggregate statistics |
| `brain_recent` | Latest entries |
| `brain_health` | Backend reachability |
| `brain_observe` | **Auto-Memory ingestion** (request + response) |
| `auto_memory_status` | Config + session counters + dedup size |
| `auto_memory_config` | Runtime config update (non-persistent) |

### Wiring Auto-Memory (required)

MCP stdio has no access to the chat transcript. Persist durable knowledge by calling:

```json
{
  "name": "brain_observe",
  "arguments": {
    "request": "…user or agent text…",
    "response": "…model or tool outcome…",
    "session_id": "optional-session",
    "project": "optional-project",
    "tool": "claude-code"
  }
}
```

Typical places: SessionEnd hook, after a verified fix, or when the agent records a decision.

## Auto-Memory behaviour

| Type | Saved when analysis detects |
|------|-----------------------------|
| `decision` | Explicit choice locked in |
| `fix` | Root cause + resolution |
| `learning` | Generalizable lesson |
| `pattern` | Reusable project pattern |
| `preference` | Stable user preference |
| `config` | Material configuration |
| `error` | Actionable failure mode |

Threshold: `AUTO_MEMORY_MIN_CONFIDENCE` (default `0.7`).  
Dedup: SHA-256 of normalized request+response, TTL `deduplicationWindowMinutes`.

## Persistence and failure semantics

- SQLite is the durable deduplication backend. Set `DEDUP_DB_PATH` or `DATA_DIR` to a writable persistent location; the default database path is `.data/auto-memory-dedup.sqlite` under the working directory.
- In `NODE_ENV=production`, SQLite is mandatory. If SQLite cannot be loaded, initialized, migrated, or opened, startup fails rather than silently falling back to process-local memory. `requireSqlite: false` cannot disable this production rule.
- Outside production, an in-memory fallback may be used when SQLite is unavailable unless `DEDUP_REQUIRE_SQLITE=1` (or `true`) is set. Memory fallback does not survive process restarts and does not coordinate across processes; it is not suitable for production.
- Deduplication uses a short-lived `pending` claim followed by a `committed` state after the backend save is acknowledged. An ambiguous save outcome (timeout, connection loss, unreadable success response, or any HTTP error) keeps the pending claim until its lease expires. This avoids an immediate duplicate retry but may delay a legitimate retry.
- The backend contract currently does not guarantee server-side idempotency keys or that any HTTP error proves no write occurred. Therefore this client does **not** claim end-to-end exactly-once persistence. A retry after lease expiry can still duplicate a write if the backend committed the first request but its response was lost.

## Environment

See `.env.example`. Critical variables:

| Variable | Purpose |
|----------|---------|
| `BRAIN_API_URL` | Backend base URL |
| `BRAIN_API_KEY` | Optional bearer token |
| `ANTHROPIC_API_KEY` | Required if Auto-Memory enabled |
| `AUTO_MEMORY_ENABLED` | `true` / `false` |
| `AUTO_MEMORY_MIN_CONFIDENCE` | `0.0`–`1.0` |
| `AUTO_MEMORY_MODEL` | Anthropic model id |
| `DATA_DIR` / `DEDUP_DB_PATH` | Persistent dedup store location |
| `DEDUP_REQUIRE_SQLITE` | Require SQLite outside production (`1` / `true`) |

## Development

```bash
npm run typecheck
npm run test:run
npm run build
```

## Contracts

- `CONTRACTS/api_contract.md` — HTTP surface the client is allowed to call
- `CONTRACTS/data_contract.md` — memory domain types + local dedup schema

## Honest limitations

1. This repo is the **MCP edge**, not the Brain storage/embedding engine.
2. Auto-Memory is **not** ambient; without `brain_observe` (or equivalent) nothing is analysed.
3. Importance classification quality is model-dependent; no published precision/recall yet — treat thresholds as policy, not science, until evaluated on labeled data.
4. `auto_memory_config` changes are process-local only.
5. SQLite deduplication protects this client from many concurrent/retry duplicates, but it cannot guarantee exactly-once persistence without a backend idempotency contract and implementation.

## License

MIT
