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

- SQLite is the durable deduplication backend. In production, set `DEDUP_DB_PATH` to an absolute database-file path or `DATA_DIR` to an absolute persistent directory. A cwd-dependent default is rejected in production so separate MCP processes cannot silently select different databases.
- SQLite's synchronous busy-lock wait is capped at 100 ms (instead of better-sqlite3's 5 s default). Under contention, the operation fails closed with `SQLITE_BUSY`; it does not dispatch a Brain write when the required dedup state transition cannot be confirmed.
- In `NODE_ENV=production`, SQLite and an explicit absolute persistent path are mandatory. If SQLite cannot be loaded, initialized, migrated, or opened, startup fails rather than silently falling back to process-local memory. `requireSqlite: false` cannot disable this production rule.
- Outside production, an in-memory fallback may be used when SQLite is unavailable unless `DEDUP_REQUIRE_SQLITE=1` (or `true`) is set. Memory fallback does not survive process restarts and does not coordinate across processes; it is not suitable for production.
- Deduplication uses the durable state sequence `pending → unknown → committed`. `pending` is a pre-dispatch reservation and expires after its effective lease. Immediately before the Brain POST, the matching owner must persist `unknown`; if that transition fails, no POST is sent. A confirmed Brain save is promoted to `committed` for the configured deduplication window.
- UNKNOWN is non-expiring and blocks automatic retries. It is reverted only when the HTTP client can positively identify a connection-establishment failure that proves no HTTP request was dispatched (`ECONNREFUSED`, `ENOTFOUND`, or `EAI_AGAIN`) and the same owner still holds the row. Timeouts, connection resets, all HTTP error statuses (including 4xx/429), and malformed/unreadable 2xx bodies remain UNKNOWN because the backend may already have processed the request. An unresolved UNKNOWN blocks that content indefinitely until an operator resolves it with the CLI below. Each time a write is left in UNKNOWN the Hub logs `write left in UNKNOWN quarantine (hash <12-char prefix>)`.
- Every Brain save sends `Idempotency-Key: <content hash>` so an idempotency-aware backend can collapse retries of an ambiguous save; backends that ignore the header get no such protection. `duplicate_in_flight` (`retryable: true`) means a live PENDING claim exists: a retry can proceed after that claim is released or its lease expires (about two minutes by default).
- Confirmed `committed` deduplication is windowed, not permanent: after `deduplicationWindowMinutes` expires, the same content hash can be saved again. The backend contract currently does not guarantee server-side idempotency keys or that any HTTP error proves no write occurred. Therefore this client does **not** claim end-to-end exactly-once persistence; a retry after the deduplication window can still duplicate a write if the backend committed the first request.

## Resolving quarantined (UNKNOWN) writes

Quarantine is lifted only by an operator, through a CLI that needs file access to the dedup database. It is deliberately **not** an MCP tool, so an AI client cannot lift it. Build first (`npm run build`), with the same `DEDUP_DB_PATH`/`DATA_DIR` the Hub uses:

```
npm run dedup:admin -- list                                  # quarantined hash prefixes, oldest first
npm run dedup:admin -- resolve <prefix> --outcome not_stored # dry run; add --yes to apply
npm run dedup:admin -- resolve <prefix> --outcome stored --yes --note "found in backend"
npm run dedup:admin -- audit                                 # application-level audit records
```

- Check the backend first. Entries carry `metadata.contentHash`; look for one starting with the prefix. `not_stored` makes the content claimable again (a retry will write it); `stored` records it as committed for the dedup window. Resolving the wrong way causes a lost memory or a duplicate, and the Hub cannot verify your claim. `not_stored` must not be selected merely because the 10-minute guard elapsed.
- Resolution is one atomic transaction with an application-level audit record on exactly one row identified by a unique 8-64 hex prefix. It never touches pending or committed rows. The CLI enforces a fixed 10-minute minimum age; this is only a delay, **not proof** that an in-flight request has completed. The operator must independently verify the backend and account for delayed/in-flight processing before choosing an outcome. The age guard cannot be lowered through the CLI.
- The audit table is append-only through the application interface, but it is not tamper-proof against a process or operator with direct write access to the SQLite file. Do not treat it as an independently anchored or immutable audit log.
- Whether the backend can actually answer "was this stored?" (and honors `Idempotency-Key`) is UNVERIFIED; this tool only makes the operator's decision possible and auditable.

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