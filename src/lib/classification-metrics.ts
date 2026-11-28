/**
 * Pure classification metrics for binary / multi-label importance evaluation.
 * Deterministic, side-effect free, unit-testable.
 */

export type BinaryLabel = boolean;

export interface BinaryPrediction {
  /** Ground-truth: should this interaction be stored? */
  expected: BinaryLabel;
  /** Model decision after all gates (isImportant && confidence floors). */
  predicted: BinaryLabel;
  /** Optional calibrated confidence from the model (0–1). */
  confidence?: number;
  /** Optional stable case id for reporting. */
  id?: string;
}

export interface ConfusionMatrix {
  tp: number;
  fp: number;
  tn: number;
  fn: number;
}

export interface ClassificationScores {
  total: number;
  accuracy: number;
  precision: number;
  recall: number;
  f1: number;
  specificity: number;
  confusion: ConfusionMatrix;
  /** Mean confidence on true positives only (undefined if no TP or no confidences). */
  meanConfidenceOnTp?: number;
  /** Cases where prediction mismatched expectation. */
  errors: Array<{ id?: string; expected: boolean; predicted: boolean; confidence?: number }>;
}

function safeDiv(n: number, d: number): number {
  return d === 0 ? 0 : n / d;
}

/**
 * Compute standard binary classification scores.
 * Precision = TP / (TP+FP) — of what we stored, how many were worth storing.
 * Recall    = TP / (TP+FN) — of what was worth storing, how many we caught.
 * F1        = harmonic mean of precision and recall.
 */
export function scoreBinaryClassifications(rows: BinaryPrediction[]): ClassificationScores {
  const confusion: ConfusionMatrix = { tp: 0, fp: 0, tn: 0, fn: 0 };
  const errors: ClassificationScores['errors'] = [];
  let confSumTp = 0;
  let confCountTp = 0;

  for (const row of rows) {
    const { expected, predicted, confidence, id } = row;

    if (expected && predicted) {
      confusion.tp += 1;
      if (typeof confidence === 'number') {
        confSumTp += confidence;
        confCountTp += 1;
      }
    } else if (!expected && predicted) {
      confusion.fp += 1;
      errors.push({ id, expected, predicted, confidence });
    } else if (expected && !predicted) {
      confusion.fn += 1;
      errors.push({ id, expected, predicted, confidence });
    } else {
      confusion.tn += 1;
    }
  }

  const { tp, fp, tn, fn } = confusion;
  const total = tp + fp + tn + fn;
  const precision = safeDiv(tp, tp + fp);
  const recall = safeDiv(tp, tp + fn);
  const f1 = safeDiv(2 * precision * recall, precision + recall);
  const accuracy = safeDiv(tp + tn, total);
  const specificity = safeDiv(tn, tn + fp);

  return {
    total,
    accuracy,
    precision,
    recall,
    f1,
    specificity,
    confusion,
    meanConfidenceOnTp: confCountTp > 0 ? confSumTp / confCountTp : undefined,
    errors,
  };
}

/**
 * Minimum acceptance gates for shipping a prompt/model change.
 * Tune these only with labeled data evidence.
 */
export interface AcceptanceGates {
  minPrecision: number;
  minRecall: number;
  minF1: number;
  minAccuracy: number;
}

export const DEFAULT_IMPORTANCE_GATES: AcceptanceGates = {
  minPrecision: 0.75,
  minRecall: 0.6,
  minF1: 0.65,
  minAccuracy: 0.7,
};

export function passesGates(
  scores: ClassificationScores,
  gates: AcceptanceGates = DEFAULT_IMPORTANCE_GATES
): { ok: boolean; failures: string[] } {
  const failures: string[] = [];
  if (scores.precision < gates.minPrecision) {
    failures.push(`precision ${scores.precision.toFixed(3)} < ${gates.minPrecision}`);
  }
  if (scores.recall < gates.minRecall) {
    failures.push(`recall ${scores.recall.toFixed(3)} < ${gates.minRecall}`);
  }
  if (scores.f1 < gates.minF1) {
    failures.push(`f1 ${scores.f1.toFixed(3)} < ${gates.minF1}`);
  }
  if (scores.accuracy < gates.minAccuracy) {
    failures.push(`accuracy ${scores.accuracy.toFixed(3)} < ${gates.minAccuracy}`);
  }
  return { ok: failures.length === 0, failures };
}
