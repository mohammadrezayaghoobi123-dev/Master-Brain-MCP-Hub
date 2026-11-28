import { afterEach, describe, expect, it, vi } from 'vitest';
import { AutoMemoryMiddleware } from '../src/middleware/auto-memory.js';
import { createMemoryDedupStore } from '../src/lib/dedup-store.js';

describe('UNKNOWN quarantine aggregate alerts', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('alerts when the quarantine count reaches 10 and suppresses identical repeats', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-14T00:00:00.000Z'));
    const store = createMemoryDedupStore();
    const middleware = new AutoMemoryMiddleware({ enabled: false }, store);
    const alert = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      for (let i = 0; i < 10; i += 1) {
        const hash = `unknown-${i}`;
        const owner = store.claim(hash, 5)!;
        expect(store.markUnknown(hash, owner)).toBe(true);
      }

      vi.advanceTimersByTime(5 * 60_000);
      expect(alert).toHaveBeenCalledTimes(1);
      expect(alert.mock.calls[0][0]).toContain('10 UNKNOWN write(s)');
      expect(alert.mock.calls[0][0]).toContain('oldest age 5m');
      expect(alert.mock.calls[0][0]).not.toMatch(/unknown-\d/);

      vi.advanceTimersByTime(10 * 60_000);
      expect(alert).toHaveBeenCalledTimes(1);
    } finally {
      middleware.close();
    }
  });

  it('alerts on a single UNKNOWN that remains quarantined for at least 60 minutes', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-14T00:00:00.000Z'));
    const store = createMemoryDedupStore();
    const middleware = new AutoMemoryMiddleware({ enabled: false }, store);
    const alert = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const owner = store.claim('long-lived-unknown', 5)!;
      expect(store.markUnknown('long-lived-unknown', owner)).toBe(true);

      vi.advanceTimersByTime(55 * 60_000);
      expect(alert).not.toHaveBeenCalled();

      vi.advanceTimersByTime(5 * 60_000);
      expect(alert).toHaveBeenCalledTimes(1);
      expect(alert.mock.calls[0][0]).toContain('1 UNKNOWN write(s)');
      expect(alert.mock.calls[0][0]).toContain('oldest age 60m');
      expect(alert.mock.calls[0][0]).not.toContain('long-lived-unknown');
    } finally {
      middleware.close();
    }
  });
});
