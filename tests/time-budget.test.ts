import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_BRAIN_TIMEOUT_MS,
  LEASE_SAFETY_MARGIN_MS,
  MAX_EFFECTIVE_LEASE_MS,
  deriveEffectiveLeaseMs,
  leaseMinutesToMs,
  parsePositiveSafeIntegerEnv,
} from '../src/lib/time-budget.js';

const originalBrainTimeout = process.env.BRAIN_TIMEOUT_MS;

afterEach(() => {
  if (originalBrainTimeout === undefined) delete process.env.BRAIN_TIMEOUT_MS;
  else process.env.BRAIN_TIMEOUT_MS = originalBrainTimeout;
});

describe('time budget validation', () => {
  it('accepts a configured lease at the exact 24-hour cap', () => {
    expect(deriveEffectiveLeaseMs(1440, 60_000, 30_000)).toBe(MAX_EFFECTIVE_LEASE_MS);
  });

  it('rejects a configured lease above the 24-hour cap', () => {
    expect(() => deriveEffectiveLeaseMs(1440.001, 60_000, 30_000)).toThrow(RangeError);
  });

  it('rejects an execution floor one millisecond above the cap', () => {
    const analysis = MAX_EFFECTIVE_LEASE_MS - 30_000 - LEASE_SAFETY_MARGIN_MS + 1;
    expect(() => deriveEffectiveLeaseMs(1, analysis, 30_000)).toThrow(RangeError);
  });

  it('raises a short configured lease to the exact execution floor', () => {
    expect(deriveEffectiveLeaseMs(1, 60_000, 30_000)).toBe(60_000 + 30_000 + LEASE_SAFETY_MARGIN_MS);
  });

  it('accepts an execution floor exactly at the cap', () => {
    const analysis = MAX_EFFECTIVE_LEASE_MS - 30_000 - LEASE_SAFETY_MARGIN_MS;
    expect(deriveEffectiveLeaseMs(1, analysis, 30_000)).toBe(MAX_EFFECTIVE_LEASE_MS);
  });

  it.each([Number.NaN, Infinity, -Infinity, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid millisecond budget %s',
    (value) => {
      expect(() => deriveEffectiveLeaseMs(1, value, 30_000)).toThrow(RangeError);
      expect(() => deriveEffectiveLeaseMs(1, 60_000, value)).toThrow(RangeError);
    }
  );

  it.each([0, -1, Number.NaN, Infinity, 0.000001, Number.MAX_SAFE_INTEGER])(
    'rejects invalid lease minutes %s',
    (minutes) => {
      expect(() => leaseMinutesToMs(minutes, 'claimLeaseMinutes')).toThrow(RangeError);
    }
  );

  it('converts an exact fractional-minute duration without precision loss', () => {
    expect(leaseMinutesToMs(0.0001, 'claimLeaseMinutes')).toBe(6);
  });

  it('uses the default only when BRAIN_TIMEOUT_MS is absent', () => {
    delete process.env.BRAIN_TIMEOUT_MS;
    expect(parsePositiveSafeIntegerEnv('BRAIN_TIMEOUT_MS', DEFAULT_BRAIN_TIMEOUT_MS)).toBe(30_000);
  });

  it.each(['', 'abc', '0', '-1', '1.5', '1e3', '9007199254740992'])(
    'rejects malformed or unsafe BRAIN_TIMEOUT_MS value %j',
    (raw) => {
      process.env.BRAIN_TIMEOUT_MS = raw;
      expect(() => parsePositiveSafeIntegerEnv('BRAIN_TIMEOUT_MS', DEFAULT_BRAIN_TIMEOUT_MS)).toThrow(RangeError);
    }
  );
});