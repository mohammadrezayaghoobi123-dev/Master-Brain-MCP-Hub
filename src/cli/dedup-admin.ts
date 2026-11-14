// Operator CLI for quarantined (UNKNOWN) auto-memory writes.
//
// Deliberately NOT an MCP tool: it needs file-level access to the dedup database, so an
// AI client can never lift the quarantine on its own. Resolving an entry is an assertion by
// the operator, made after checking the backend, about whether the write was persisted.
//
//   npm run dedup:admin -- list
//   npm run dedup:admin -- resolve <hash-prefix> --outcome not_stored|stored [--yes]
//   npm run dedup:admin -- audit [--limit N]
import { userInfo } from 'node:os';
import { pathToFileURL } from 'node:url';
import {
  createDedupStore,
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

const USAGE = [
  'Usage:',
  '  dedup-admin list',
  '  dedup-admin resolve <hash-prefix> --outcome not_stored|stored [--note TEXT]',
  `                      [--ttl-minutes N (stored only, default ${DEFAULT_RESOLVE_TTL_MINUTES})] [--yes]`,
  '  dedup-admin audit [--limit N]',
].join('\n');

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
      store = createDedupStore();
      if (store.backend !== 'sqlite') {
        io.err('No persistent SQLite dedup store is configured; there is nothing to resolve. Set DEDUP_DB_PATH or DATA_DIR.');
        return EXIT_REFUSED;
      }
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
      io.out(`Dry run only: no state changed. The store will validate that ${prefix} identifies exactly one UNKNOWN entry when applied.`);
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
      minAgeMs: DEFAULT_MIN_AGE_MINUTES * 60_000,
      ttlMinutes,
      note,
      now,
    });
    if (!result.ok) {
      const why: Record<string, string> = {
        invalid_prefix: 'The hash prefix must be 8-64 hexadecimal characters.',
        not_found: 'No UNKNOWN entry matches that prefix (it may already be resolved).',
        ambiguous: 'More than one UNKNOWN entry matches; use a longer prefix.',
        too_recent: `The entry was quarantined less than ${DEFAULT_MIN_AGE_MINUTES} minutes ago; a request may still be in flight.`,
        missing_timestamp: 'The UNKNOWN entry has no quarantine timestamp; refusing to resolve corrupted or legacy state.',
      };
      io.err(`Refused: ${why[result.reason]}`);
      return EXIT_REFUSED;
    }
    io.out(`Resolved ${result.hashPrefix} as ${result.outcome} (recorded for audit as ${operator}).`);
    return EXIT_OK;
  } finally {
    if (ownsStore && store) store.close();
  }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try {
    process.exitCode = runCli(process.argv.slice(2));
  } catch (error) {
    console.error(`dedup-admin failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = EXIT_REFUSED;
  }
}
