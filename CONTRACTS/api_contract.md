# API Contract — Master Brain Backend

> **REGEL:** Client (dieses MCP Hub) darf NUR das verwenden, was hier steht.
> Änderungen nur mit expliziter Genehmigung: `ÄNDERUNG ERLAUBT: ...`

**Version:** 1.1.0  
**Letzte Änderung:** 2026-11-08  
**Genehmigt:** engineering review (aligned with `src/brain/client.ts`)

---

## Konventionen

### Request Format
- Content-Type: `application/json`
- Auth: `Authorization: Bearer <token>` (optional if network-trusted)

### Error Format
```json
{
  "error": "Kurze Fehlermeldung",
  "message": "optional duplicate for compatibility",
  "code": "OPTIONAL_MACHINE_CODE"
}
```

### HTTP Status Codes
| Code | Bedeutung |
|------|-----------|
| 200 | OK |
| 201 | Created |
| 400 | Bad Request |
| 401 | Unauthorized |
| 403 | Forbidden |
| 404 | Not Found |
| 429 | Too Many Requests |
| 500 | Internal Server Error |

---

## Brain Endpoints (implemented by client)

### GET /api/brain/health
**Auth:** Optional  
**Response 200:**
```json
{
  "status": "ok",
  "version": "1.0.0"
}
```

### POST /api/brain/entries
**Auth:** Bearer recommended  
**Request headers:**
- `Content-Type: application/json`
- `Authorization: Bearer <token>` when configured
- The Hub currently sends `Idempotency-Key: <content hash>` for Auto-Memory saves. This documents client behavior only; Backend support, key scope, retention, conflict behavior, and replay semantics are **UNVERIFIED**. Do not rely on this header for duplicate-write protection until the deployed Backend contract and implementation are independently confirmed.

**Request body:**
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
**Response 200:** empty or `{ "ok": true }`.

---

## Changelog

| Datum | Änderung | Genehmigt von |
|-------|----------|---------------|
| 2026-11-08 | Aligned endpoints with BrainClient; removed placeholders | engineering |
