# API Contract — Master Brain Backend

> **REGEL:** Client (dieses MCP Hub) darf NUR das verwenden, was hier steht.
> Änderungen nur mit expliziter Genehmigung: `ÄNDERUNG ERLAUBT: ...`

**Version:** 1.2.0  
**Letzte Änderung:** 2026-11-28  
**Genehmigt:** engineering (aligned with `src/brain/client.ts`)

---

## Conventions

### Request Format
- Content-Type: `application/json`
- Auth: `Authorization: Bearer <token>` (optional if network-trusted)

### Idempotency (POST writes)
- Header: `Idempotency-Key: <string>` (required by MCP Hub client on every `POST /api/brain/entries`)
- Backend SHOULD treat the same key + same principal as the same logical write within a retention window (≥ 24h recommended).
- Replay with the same key MUST return the original resource (200/201) without creating a duplicate.
- MCP Hub generates the key from content-hash when available; otherwise a UUID.

### Error Format
```json
{
  "error": "short message",
  "message": "optional duplicate for compatibility",
  "code": "OPTIONAL_MACHINE_CODE"
}
```

### HTTP Status Codes
| Code | Meaning |
|------|---------|
| 200 | OK |
| 201 | Created |
| 204 | No Content |
| 400 | Bad Request |
| 401 | Unauthorized |
| 403 | Forbidden |
| 404 | Not Found |
| 409 | Conflict (optional; idempotent replay may use 200 instead) |
| 429 | Too Many Requests (`Retry-After` respected by client diagnostics) |
| 500 | Internal Server Error |
| 502 / 503 / 504 | Transient — MCP Hub may retry when request is idempotent |

### MCP Hub client retry policy (normative for this repo)
| Method | Retry | Notes |
|--------|-------|-------|
| GET health | no | single attempt; structured failure reason |
| GET search/stats/recent | yes | up to `BRAIN_MAX_ATTEMPTS` (default 3) on UNREACHABLE / TIMEOUT / 502–504 |
| POST entries | yes | only because `Idempotency-Key` is always sent |
| DELETE entries/:id | no | not assumed idempotent across all backends |

Backoff: 200ms × 2^(attempt-1), cap 2000ms.

---

## Brain Endpoints

### GET /api/brain/health
**Auth:** Optional  
**Response 200:**
```json
{
  "status": "ok",
  "version": "1.0.0"
}
```

**MCP Hub client mapping when not ok:**
| reason | meaning |
|--------|--------|
| `timeout` | request aborted by client timeout |
| `unreachable` | network / DNS / connection failure |
| `http_error` | non-2xx from backend |
| `invalid_payload` | 2xx but body missing `status: "ok"` |

### POST /api/brain/entries
**Auth:** Bearer recommended  
**Headers:** `Idempotency-Key` (required by Hub client)

**Request:**
```json
{
  "type": "decision|fix|learning|pattern|preference|config|error|context|conversation",
  "content": "string",
  "summary": "string (optional)",
  "tags": ["string"],
  "source": {
    "tool": "claude-code|codex|cursor|api|manual|auto-memory",
    "session_id": "string (optional)",
    "project": "string (optional)",
    "file": "string (optional)",
    "user_id": "string (optional)"
  },
  "metadata": {}
}
```
**Response 200/201:** full `BrainEntry` including `id` and `timestamp` (ISO-8601 string).

### GET /api/brain/search
**Query parameters:**
| Param | Type | Default | Notes |
|-------|------|---------|-------|
| q | string | required | search query |
| mode | semantic\|keyword\|hybrid | hybrid | |
| type | MemoryType | — | optional filter |
| tags | comma-separated | — | optional filter |
| limit | int 1–50 | 10 | |

**Response 200:**
```json
{
  "entries": [/* BrainEntry */],
  "total": 0,
  "query": "…",
  "mode": "hybrid"
}
```

### GET /api/brain/stats
**Response 200:**
```json
{
  "totalEntries": 0,
  "entriesByType": { "decision": 0 },
  "entriesBySource": { "claude-code": 0 },
  "lastUpdated": "2026-11-08T00:00:00.000Z",
  "storageSize": "0 B"
}
```

### GET /api/brain/recent
**Query parameters:** `limit` (default 10), `type` (optional MemoryType)

**Response 200:** array of `BrainEntry`.

### DELETE /api/brain/entries/:id
**Response 200/204:** empty or `{ "ok": true }`.

---

## Changelog

| Date | Change | Approved by |
|------|--------|-------------|
| 2026-11-08 | Aligned endpoints with BrainClient; removed placeholders | engineering |
| 2026-11-28 | v1.2.0: Idempotency-Key, retry policy, health reason taxonomy | engineering |
