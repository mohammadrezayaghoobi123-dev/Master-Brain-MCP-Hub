import { describe, it, expect } from 'vitest';
import {
  scoreBinaryClassifications,
  passesGates,
  DEFAULT_IMPORTANCE_GATES,
  type BinaryPrediction,
} from '../src/lib/classification-metrics.js';

describe('scoreBinaryClassifications', () => {
  it('computes perfect scores', () => {
    const rows: BinaryPrediction[] = [
      { expected: true, predicted: true, confidence: 0.9 },
      { expected: false, predicted: false, confidence: 0.1 },
      { expected: true, predicted: true, confidence: 0.85 },
      { expected: false, predicted: false },
    ];
    const s = scoreBinaryClassifications(rows);
    expect(s.total).toBe(4);
    expect(s.accuracy).toBe(1);
    expect(s.precision).toBe(1);
    expect(s.recall).toBe(1);
    expect(s.f1).toBe(1);
    expect(s.confusion).toEqual({ tp: 2, fp: 0, tn: 2, fn: 0 });
    expect(s.meanConfidenceOnTp).toBeCloseTo(0.875);
    expect(s.errors).toHaveLength(0);
  });

  it('handles false positives and false negatives', () => {
    const rows: BinaryPrediction[] = [
      { id: 'a', expected: true, predicted: true, confidence: 0.9 }, // TP
      { id: 'b', expected: true, predicted: false, confidence: 0.4 }, // FN
      { id: 'c', expected: false, predicted: true, confidence: 0.8 }, // FP
      { id: 'd', expected: false, predicted: false }, // TN
    ];
    const s = scoreBinaryClassifications(rows);
    expect(s.confusion).toEqual({ tp: 1, fp: 1, tn: 1, fn: 1 });
    expect(s.precision).toBeCloseTo(0.5);
    expect(s.recall).toBeCloseTo(0.5);
    expect(s.f1).toBeCloseTo(0.5);
    expect(s.accuracy).toBeCloseTo(0.5);
    expect(s.errors.map((e) => e.id).sort()).toEqual(['b', 'c']);
  });

  it('returns zeros safely on empty input', () => {
    const s = scoreBinaryClassifications([]);
    expect(s.total).toBe(0);
    expect(s.precision).toBe(0);
    expect(s.recall).toBe(0);
    expect(s.f1).toBe(0);
    expect(s.accuracy).toBe(0);
  });
});

describe('passesGates', () => {
  it('passes strong scores', () => {
    const s = scoreBinaryClassifications([
      { expected: true, predicted: true },
      { expected: true, predicted: true },
      { expected: true, predicted: true },
      { expected: false, predicted: false },
      { expected: false, predicted: false },
      { expected: false, predicted: true }, // 1 FP
    ]);
    // precision 3/4=0.75, recall 1.0, f1 ~0.857, acc 5/6~0.833
    const gate = passesGates(s, DEFAULT_IMPORTANCE_GATES);
    expect(gate.ok).toBe(true);
    expect(gate.failures).toHaveLength(0);
  });

  it('fails weak precision', () => {
    const s = scoreBinaryClassifications([
      { expected: true, predicted: true },
      { expected: false, predicted: true },
      { expected: false, predicted: true },
      { expected: false, predicted: true },
    ]);
    const gate = passesGates(s, { ...DEFAULT_IMPORTANCE_GATES, minPrecision: 0.8 });
    expect(gate.ok).toBe(false);
    expect(gate.failures.some((f) => f.startsWith('precision'))).toBe(true);
  });
});
