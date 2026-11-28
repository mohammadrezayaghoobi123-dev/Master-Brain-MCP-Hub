# API Contract — Master Brain Backend

> **REGEL:** Client (dieses MCP Hub) darf NUR das verwenden, was hier steht.
> Vertragsänderungen benötigen eine explizite Projektfreigabe. Diese Präzisierung wurde durch die ausdrückliche Projektowner-Anweisung vom 2026-11-28 autorisiert.

**Version:** 1.1.1  
**Letzte Änderung:** 2026-11-28  
**Änderungsfreigabe:** project owner (explicit authorization)  
**Conformance-Hinweis:** Dieses Dokument definiert die erwartete Hub↔Backend-Schnittstelle. Es beweist nicht, dass ein bestimmter deployed Backend-Endpoint diese Spezifikation erfüllt; dafür ist ein separater, gegen eine identifizierte Backend-Version ausgeführter Contract-Test erforderlich.

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

For `POST /api/brain/entries`, only **200** and **201** are documented success statuses. A generic 2xx status is not sufficient to confirm persistence: 202 does not confirm that the write is complete, and 204 provides no `BrainEntry` representation.

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
**Request:**
```json
{
  "type": "decision|fix|learning|pattern|preference|config|error|context|conversation",
  "content": "string (1–10000 characters)",
  "summary": "string (optional, max 200 characters)",
  "tags": ["1–10 non-empty strings"],
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

**Response 200/201:** Full `BrainEntry`, including server-assigned `id` (UUID) and `timestamp` (ISO-8601 string). The complete field-level constraints for `BrainEntry` and `MemorySource` are normative in `CONTRACTS/data_contract.md` → `BrainEntry` / `MemorySource`; they are not redefined independently here.

**Hub confirmation rule:** The Hub treats a save as confirmed only when the HTTP status is 200 or 201 **and** the returned body satisfies the complete `BrainEntry` domain contract. A missing, unreadable, malformed, or out-of-contract response after a dispatched write is an ambiguous outcome and remains in local `UNKNOWN` quarantine; it is not automatically retried. This is a client safety rule, not evidence that the deployed Backend has been tested for conformance.

The Hub sends `Idempotency-Key: <content hash>` when a content hash is available. Backend support for this header is optional/unverified unless the deployed Backend is independently proven to implement it. No end-to-end exactly-once guarantee is made.

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
  "entries": ["BrainEntry"],
  "total": 0,
  "query": "…",
  "mode": "hybrid"
}
```
Each returned entry follows the `BrainEntry` domain contract referenced above.

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

**Response 200:** array of `BrainEntry`. Each returned entry follows the `BrainEntry` domain contract referenced above.

### DELETE /api/brain/entries/:id
**Response 200:** empty or `{ "ok": true }`.

---

## Changelog

| Datum | Änderung | Genehmigt von |
|-------|----------|---------------|
| 2026-11-08 | Aligned endpoints with BrainClient; removed placeholders | engineering |
| 2026-11-28 | Referenced canonical BrainEntry constraints, specified POST success statuses, and documented the external Backend conformance boundary | project owner (explicit authorization) |
