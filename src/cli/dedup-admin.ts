// Operator CLI for quarantined (UNKNOWN) auto-memory writes.
//
// Deliberately NOT an MCP tool: it needs file-level access to the dedup database, so an
// AI client can never lift the quarantine on its own. Resolving an entry is an assertion by
// the operator, made after checking the backend, about whether the write was persisted.
//
//   npm run dedup:admin -- list
//   npm run dedup:admin -- resolve <hash-prefix> --outcome not_stored|stored [--yes]
//   npm run dedup:admin -- audit [--limit N]
import { existsSync, realpathSync } from 'node:fs';
import { userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DEFAULT_BRAIN_TIMEOUT_MS, parsePositiveSafeIntegerEnv } from '../lib/time-budget.js';
import {
  createDedupStore,
  locateDedupDb,
  DEFAULT_RESOLVE_TTL_MINUTES,
  type DedupStore,
  type UnknownOutcome,
} from '../lib/dedup-store.js';

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

export interface CliOptions {
  io?: CliIo;
  /** Injected store (tests). When omitted the configured store is opened and closed here. */
  store?: DedupStore;
  now?: number;
  operator?: string;
}

export const EXIT_OK = 0;
export const EXIT_USAGE = 1;
export const EXIT_REFUSED = 2;
export const EXIT_CONFIRM = 3;

const DEFAULT_MIN_AGE_MINUTES = 10;

/**
 * Oldest an UNKNOWN entry may be before an operator can resolve it: the larger of the fixed floor
 * and twice the configured Brain timeout (+1s), so a request that is still legitimately in flight
 * (or about to time out) can never be resolved as 'not stored'. Mirrors the budget the middleware
 * persists with each entry; this covers rows written before that column existed.
 */
export function minResolveAgeMs(): number {
  const timeoutMs = parsePositiveSafeIntegerEnv('BRAIN_TIMEOUT_MS', DEFAULT_BRAIN_TIMEOUT_MS);
  return Math.max(DEFAULT_MIN_AGE_MINUTES * 60_000, timeoutMs * 2 + 1000);
}

/** True when this module is the process entrypoint, also through npm/.bin symlinks. */
export function isEntrypoint(metaUrl: string, argv1: string | undefined): boolean {
  if (argv1 === undefined) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(argv1);
  } catch {
    return false;
  }
}

const USAGE = [
  'Usage:',
  '  dedup-admin list',
  '  dedup-admin resolve <hash-prefix> --outcome not_stored|stored [--note TEXT]',
  `                      [--ttl-minutes N (REQUIRED for stored; must equal the Hub's dedup window, e.g. ${DEFAULT_RESOLVE_TTL_MINUTES})] [--yes]`,
  '  dedup-admin audit [--limit N]',
].join('\n');

const REFUSAL_TEXT: Record<string, string> = {
  invalid_prefix: 'The hash prefix must be 8-64 hexadecimal characters.',
  not_found: 'No UNKNOWN entry matches that prefix (it may already be resolved).',
  ambiguous: 'More than one UNKNOWN entry matches; use a longer prefix.',
  too_recent: 'The entry was quarantined too recently; a request may still be in flight.',
  in_flight: "The request's own timeout budget has not elapsed yet; it may still complete.",
  missing_timestamp: 'The UNKNOWN entry has no quarantine timestamp; refusing to resolve corrupted or legacy state.',
};

function parseFlags(args: string[]): { positional: string[]; flags: Map<string, string | true> } {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const next = args[i + 1];
    if (name === 'yes' || next === undefined || next.startsWith('--')) {
      flags.set(name, true);
    } else {
      flags.set(name, next);
      i += 1;
    }
  }
  return { positional, flags };
}

function positiveNumber(value: string | true | undefined, fallback: number): number | null {
  if (value === undefined) return fallback;
  if (value === true) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function age(from: number | null, now: number): string {
  if (from === null) return 'unknown age';
  const minutes = Math.max(0, Math.round((now - from) / 60_000));
  return minutes < 120 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
}

export function runCli(argv: string[], options: CliOptions = {}): number {
  const io: CliIo = options.io ?? { out: (l) => console.log(l), err: (l) => console.error(l) };
  const now = options.now ?? Date.now();
  const [command, ...rest] = argv;
  if (!command || !['list', 'resolve', 'audit'].includes(command)) {
    io.err(USAGE);
    return EXIT_USAGE;
  }

  let store = options.store;
  const ownsStore = store === undefined;
  try {
    if (!store) {
      const location = locateDedupDb();
      if (!existsSync(location.path)) {
        io.err(
          `No dedup database at ${location.path}. Refusing to create one: set DEDUP_DB_PATH (or DATA_DIR) to the Hub's database.`
        );
        return EXIT_REFUSED;
      }
      store = createDedupStore(undefined, { requireSqlite: true });
      io.out(`Dedup database: ${location.path}`);
    }
    const { positional, flags } = parseFlags(rest);

    if (command === 'list') {
      const rows = store.listUnknown(1000);
      if (rows.length === 0) {
        io.out('No quarantined (UNKNOWN) entries.');
        return EXIT_OK;
      }
      io.out(`${rows.length} quarantined (UNKNOWN) entr${rows.length === 1 ? 'y' : 'ies'} (oldest first):`);
      for (const row of rows) {
        const since = row.unknownSince === null ? 'unknown' : new Date(row.unknownSince).toISOString();
        io.out(`  ${row.hashPrefix}  since ${since}  (${age(row.unknownSince, now)})`);
      }
      return EXIT_OK;
    }

    if (command === 'audit') {
      const limit = positiveNumber(flags.get('limit'), 50);
      if (limit === null) {
        io.err('--limit must be a positive number');
        return EXIT_USAGE;
      }
      const records = store.listResolutions(limit);
      if (records.length === 0) io.out('No resolutions recorded.');
      for (const r of records) {
        io.out(`${new Date(r.at).toISOString()}  ${r.hashPrefix}  ${r.outcome}  by ${r.operator}${r.note ? `  — ${r.note}` : ''}`);
      }
      return EXIT_OK;
    }

    // resolve
    const prefix = positional[0];
    const outcome = flags.get('outcome');
    if (!prefix || (outcome !== 'not_stored' && outcome !== 'stored')) {
      io.err(USAGE);
      return EXIT_USAGE;
    }
    if (outcome === 'stored' && !flags.has('ttl-minutes')) {
      io.err("--ttl-minutes is required for --outcome stored and must equal the Hub's dedup window (a wrong value shortens or extends duplicate protection)");
      return EXIT_USAGE;
    }
    const ttlMinutes = positiveNumber(flags.get('ttl-minutes'), DEFAULT_RESOLVE_TTL_MINUTES);
    if (ttlMinutes === null) {
      io.err('--ttl-minutes must be a positive number');
      return EXIT_USAGE;
    }
    if (flags.has('min-age-minutes')) {
      io.err('--min-age-minutes is fixed at 10 minutes and cannot be lowered; elapsed time is not proof that a request completed');
      return EXIT_USAGE;
    }
    const note = typeof flags.get('note') === 'string' ? (flags.get('note') as string) : undefined;

    if (flags.get('yes') !== true) {
      const preview = store.inspectUnknown(prefix, { minAgeMs: minResolveAgeMs(), now });
      io.out('Dry run only: no state changed.');
      if (preview.ok) {
        io.out(`Matched ${preview.hashPrefix}, quarantined ${age(preview.unknownSince, now)} ago; eligible for resolution.`);
      } else {
        io.out(`This would be REFUSED: ${REFUSAL_TEXT[preview.reason]}`);
      }
      io.out(
        outcome === 'not_stored'
          ? 'NOT_STORED makes this content claimable again: a retry will write it. Confirm in the backend that no entry with this contentHash exists first.'
          : 'STORED records the write as committed for the dedup window. Confirm in the backend that the entry exists first.'
      );
      io.out('Re-run with --yes to apply.');
      return EXIT_CONFIRM;
    }

    const operator = options.operator ?? userInfo().username;
    const result = store.resolveUnknown(prefix, {
      outcome: outcome as UnknownOutcome,
      operator,
      minAgeMs: minResolveAgeMs(),
      ttlMinutes,
      note,
      now,
    });
    if (!result.ok) {
      io.err(`Refused: ${REFUSAL_TEXT[result.reason]}`);
      return EXIT_REFUSED;
    }
    io.out(`Resolved ${result.hashPrefix} as ${result.outcome} (recorded for audit as ${operator}).`);
    return EXIT_OK;
  } finally {
    if (ownsStore && store) store.close();
  }
}

if (isEntrypoint(import.meta.url, process.argv[1])) {
  try {
    process.exitCode = runCli(process.argv.slice(2));
  } catch (error) {
    console.error(`dedup-admin failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = EXIT_REFUSED;
  }
}
