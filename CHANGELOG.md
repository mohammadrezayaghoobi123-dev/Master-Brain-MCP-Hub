# Changelog

Format based on [Keep a Changelog](https://keepachangelog.com/).

## 1.1.0 — 2026-11-08

Engineering hardening pass (atomic fixes against review findings).

### Fixed
- **Auto-Memory was dead code**: no call path existed from the MCP server. Added explicit tool `brain_observe` and documented that stdio MCP cannot passively observe chat — callers must invoke observe.
- **Weak dedup hash**: replaced custom 32-bit rolling hash with SHA-256 (`src/lib/hash.ts`) and whitespace normalization.
- **Ephemeral dedup state**: added SQLite-backed `DedupStore` with in-memory fallback (`src/lib/dedup-store.ts`).
- **Unvalidated model JSON**: Haiku analysis output is now parsed with Zod (`analysisSchema`).
- **Tool boundary validation**: every tool argument is `safeParse`d in `src/index.ts` before handlers run.
- **Unstructured errors**: introduced `AppError` + `StructuredError` (`code`, `message`, `details?`) on all failure paths.
- **API contract drift**: `CONTRACTS/api_contract.md` and `data_contract.md` aligned with the real client and memory domain (removed placeholders).
- **Public infrastructure leakage**: README no longer embeds a production IP; `.env.example` uses localhost only.
- **MemoryType inconsistency**: single canonical `MEMORY_TYPES` array shared by types, Zod enums, and tool schemas (includes `conversation`).
- **Hard-coded analysis model**: configurable via `AUTO_MEMORY_MODEL`.

### Added
- Tool: `brain_observe`
- Modules: `src/lib/errors.ts`, `src/lib/hash.ts`, `src/lib/dedup-store.ts`, `src/tools/observe.ts`
- Tests: `tests/hash.test.ts`, `tests/auto-memory.test.ts` (plus tightened client tests)

### Changed
- Version bump to 1.1.0
- README rewritten for accuracy (explicit auto-memory, honest limitations)

## 1.0.0

Initial scaffold.
