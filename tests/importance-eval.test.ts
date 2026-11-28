/**
 * Importance evaluation harness.
 *
 * Offline (default): validates fixture integrity + metrics math against
 * oracle labels (expectedImportant as both expected and predicted) to
 * prove the scoring pipeline is wired.
 *
 * Live (opt-in): set RUN_LIVE_EVAL=1 and ANTHROPIC_API_KEY to call the
 * real classifier. Live runs are excluded from default CI.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  scoreBinaryClassifications,
  passesGates,
  DEFAULT_IMPORTANCE_GATES,
  type BinaryPrediction,
} from '../src/lib/classification-metrics.js';

interface ImportanceCase {
  id: string;
  expectedImportant: boolean;
  expectedType: string;
  request: string;
  response: string;
}

function loadCases(): ImportanceCase[] {
  const raw = readFileSync(
    join(__dirname, 'fixtures', 'importance-cases.json'),
    'utf8'
  );
  return JSON.parse(raw) as ImportanceCase[];
}

describe('importance fixture integrity', () => {
  const cases = loadCases();

  it('has a balanced minimum seed set', () => {
    expect(cases.length).toBeGreaterThanOrEqual(10);
    const positives = cases.filter((c) => c.expectedImportant).length;
    const negatives = cases.length - positives;
    expect(positives).toBeGreaterThanOrEqual(5);
    expect(negatives).toBeGreaterThanOrEqual(4);
  });

  it('every case has required fields', () => {
    for (const c of cases) {
      expect(c.id).toBeTruthy();
      expect(typeof c.expectedImportant).toBe('boolean');
      expect(c.request.length).toBeGreaterThan(0);
      expect(c.response.length).toBeGreaterThan(0);
      expect(c.expectedType).toBeTruthy();
    }
  });

  it('ids are unique', () => {
    const ids = cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('importance scoring pipeline (offline oracle)', () => {
  it('oracle labels score perfectly and pass default gates', () => {
    const cases = loadCases();
    const rows: BinaryPrediction[] = cases.map((c) => ({
      id: c.id,
      expected: c.expectedImportant,
      predicted: c.expectedImportant,
      confidence: c.expectedImportant ? 0.9 : 0.2,
    }));

    const scores = scoreBinaryClassifications(rows);
    expect(scores.accuracy).toBe(1);
    expect(scores.precision).toBe(1);
    expect(scores.recall).toBe(1);
    expect(scores.f1).toBe(1);

    const gate = passesGates(scores, DEFAULT_IMPORTANCE_GATES);
    expect(gate.ok).toBe(true);
  });

  it('detects a degraded classifier via gates', () => {
    const cases = loadCases();
    // Simulate a noisy model: flip half of the labels
    const rows: BinaryPrediction[] = cases.map((c, i) => ({
      id: c.id,
      expected: c.expectedImportant,
      predicted: i % 2 === 0 ? c.expectedImportant : !c.expectedImportant,
      confidence: 0.5,
    }));

    const scores = scoreBinaryClassifications(rows);
    const gate = passesGates(scores, DEFAULT_IMPORTANCE_GATES);
    // Noisy predictions should fail at least one gate
    expect(gate.ok).toBe(false);
    expect(gate.failures.length).toBeGreaterThan(0);
  });
});

const runLive = process.env.RUN_LIVE_EVAL === '1' && Boolean(process.env.ANTHROPIC_API_KEY);

describe.skipIf(!runLive)('importance live model evaluation', () => {
  it('scores real analyzeImportance decisions against labels', async () => {
    // Dynamic import keeps default test runs free of Anthropic client init side effects.
    const { AutoMemoryMiddleware } = await import('../src/middleware/auto-memory.js');

    const cases = loadCases();
    const mw = new AutoMemoryMiddleware({
      enabled: true,
      minConfidence: 0.7,
      maxEntriesPerSession: 10_000,
    });

    const rows: BinaryPrediction[] = [];

    try {
      for (const c of cases) {
        // Access private method only for evaluation (engineering tradeoff).
        const analysis = await (
          mw as unknown as {
            analyzeImportance: (
              req: string,
              res: string
            ) => Promise<{ isImportant: boolean; confidence: number }>;
          }
        ).analyzeImportance(c.request, c.response);

        const effectiveMin = Math.max(0.7, 0.75);
        const predicted =
          analysis.isImportant && analysis.confidence >= effectiveMin;

        rows.push({
          id: c.id,
          expected: c.expectedImportant,
          predicted,
          confidence: analysis.confidence,
        });
      }
    } finally {
      mw.close();
    }

    const scores = scoreBinaryClassifications(rows);
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify(
        {
          total: scores.total,
          accuracy: scores.accuracy,
          precision: scores.precision,
          recall: scores.recall,
          f1: scores.f1,
          confusion: scores.confusion,
          meanConfidenceOnTp: scores.meanConfidenceOnTp,
          errors: scores.errors,
        },
        null,
        2
      )
    );

    const gate = passesGates(scores, DEFAULT_IMPORTANCE_GATES);
    expect(gate.ok, gate.failures.join('; ')).toBe(true);
  }, 120_000);
});
