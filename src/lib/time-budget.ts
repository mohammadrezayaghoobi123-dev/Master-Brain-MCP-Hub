export const DEFAULT_BRAIN_TIMEOUT_MS = 30_000;
export const DEFAULT_ANALYSIS_TIMEOUT_MS = 60_000;
export const LEASE_SAFETY_MARGIN_MS = 1_000;
export const MAX_EFFECTIVE_LEASE_MS = 86_400_000;
export const MAX_NODE_TIMEOUT_MS = 2_147_483_647;

/** Validate a duration before passing it to a Node timer or SDK timeout option. */
export function assertPositiveSafeIntegerMs(value: unknown, name: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > MAX_NODE_TIMEOUT_MS
  ) {
    throw new RangeError(
      `[TimeBudget] ${name} must be a positive safe integer <= ${MAX_NODE_TIMEOUT_MS} ms, got ${String(value)}`
    );
  }
  return value;
}

/** Missing environment variables use defaults; supplied malformed values fail closed. */
export function parsePositiveSafeIntegerEnv(name: string, fallbackMs: number): number {
  const raw = process.env[name];
  if (raw === undefined) return assertPositiveSafeIntegerMs(fallbackMs, `${name} default`);

  const normalized = raw.trim();
  if (!/^\d+$/.test(normalized)) {
    throw new RangeError(`[TimeBudget] ${name} must contain a positive base-10 integer, got ${JSON.stringify(raw)}`);
  }
  return assertPositiveSafeIntegerMs(Number(normalized), name);
}

/** Convert minutes to exact integer milliseconds without overflow or precision loss. */
export function leaseMinutesToMs(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new RangeError(`[TimeBudget] ${name} must be a positive finite number of minutes, got ${String(value)}`);
  }
  const milliseconds = value * 60_000;
  if (!Number.isSafeInteger(milliseconds)) {
    throw new RangeError(`[TimeBudget] ${name} cannot be represented as exact safe integer milliseconds, got ${String(value)}`);
  }
  return milliseconds;
}

/**
 * Derive the claim lifetime from the longest sequential critical path:
 * importance analysis -> Brain request -> finalization safety reserve.
 */
export function deriveEffectiveLeaseMs(
  configuredLeaseMinutes: unknown,
  analysisTimeoutMs: unknown,
  brainTimeoutMs: unknown
): number {
  const configuredLeaseMs = leaseMinutesToMs(configuredLeaseMinutes, 'claimLeaseMinutes');
  if (configuredLeaseMs > MAX_EFFECTIVE_LEASE_MS) {
    throw new RangeError(
      `[TimeBudget] configured claim lease exceeds ${MAX_EFFECTIVE_LEASE_MS} ms`
    );
  }

  const analysisMs = assertPositiveSafeIntegerMs(analysisTimeoutMs, 'analysisTimeoutMs');
  const brainMs = assertPositiveSafeIntegerMs(brainTimeoutMs, 'brainTimeoutMs');
  const executionFloorMs = analysisMs + brainMs + LEASE_SAFETY_MARGIN_MS;

  if (!Number.isSafeInteger(executionFloorMs) || executionFloorMs > MAX_EFFECTIVE_LEASE_MS) {
    throw new RangeError(
      `[TimeBudget] execution critical path exceeds the ${MAX_EFFECTIVE_LEASE_MS} ms maximum lease`
    );
  }

  const effectiveLeaseMs = Math.max(configuredLeaseMs, executionFloorMs);
  if (effectiveLeaseMs > MAX_EFFECTIVE_LEASE_MS) {
    throw new RangeError(
      `[TimeBudget] effective claim lease exceeds ${MAX_EFFECTIVE_LEASE_MS} ms`
    );
  }
  return effectiveLeaseMs;
}
