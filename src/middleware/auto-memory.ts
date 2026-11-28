// Auto-Memory Middleware
// Analyses interactions and persists only high-confidence durable knowledge.
//
// Design constraint (MCP stdio): this process cannot silently observe the
// full LLM conversation. Callers (agent hooks, SessionEnd, or the agent
// itself) MUST invoke processInteraction / the brain_observe tool explicitly.
//
// Pipeline (atomic stages):
//   1. enabled + session rate limit
//   2. content-hash dedup
//   3. model importance classification
//   4. confidence hard floor + config min
//   5. excludeTypes + non-empty tags
//   6. brain.save → then record dedup + session count

import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type {
  AnalysisResult,
  AutoMemoryConfig,
  MemorySource,
  MemoryType,
} from '../types/index.js';
import { MEMORY_TYPES } from '../types/index.js';
import { getBrainClient } from '../brain/client.js';
import { contentHash } from '../lib/hash.js';
import { createDedupStore, type DedupStore } from '../lib/dedup-store.js';
import { AppError } from '../lib/errors.js';

const SUMMARY_MAX = 180;
const TAG_MAX = 5;
const TAG_LEN_MAX = 64;

const analysisSchema = z.object({
  isImportant: z.boolean(),
  type: z.enum(MEMORY_TYPES),
  summary: z.string().min(1).max(200),
  tags: z.array(z.string().min(1).max(TAG_LEN_MAX)).max(TAG_MAX),
  confidence: z.number().min(0).max(1),
  context: z.string().max(500).optional(),
});

/** Absolute floor: model importance below this is always rejected. */
const CONFIDENCE_HARD_FLOOR = 0.75;

const CLASSIFIER_SYSTEM = `You are a strict, high-precision Memory Importance Classifier for an engineering knowledge system (Master Brain).

Single task: decide whether the interaction contains durable, reusable knowledge worth long-term storage. Reject everything else.

### Durable Knowledge (ONLY these qualify as isImportant=true)
- Explicit decision that constrains future work
- Root-cause analysis + concrete fix
- Generalizable learning or principle
- Reusable pattern or anti-pattern
- Stable user/project preference
- Material configuration or architectural choice
- Actionable, non-transient error mode

### Hard Rejection (must set isImportant=false)
- Small talk, acknowledgments, status updates
- One-off questions with no lasting value
- Transient debugging noise without root cause
- Pure speculation without conclusion
- Trivial or already-obvious information
- Anything you would assign confidence < 0.75

### Output Rules (CRITICAL)
- Respond with ONLY valid JSON. No markdown fences, no commentary, no extra text.
- summary: max ${SUMMARY_MAX} characters, factual, no fluff
- tags: 1-${TAG_MAX} items, lowercase, specific, use hyphens not spaces
- confidence: calibrated probability in [0.0, 1.0]; be conservative
- type must be one of: decision | fix | learning | pattern | preference | config | error | context | conversation

### JSON shape
{"isImportant":boolean,"type":"decision|fix|learning|pattern|preference|config|error|context|conversation","summary":"string","tags":["string"],"confidence":number,"context":"string optional max 300"}`;

const DEFAULT_CONFIG: AutoMemoryConfig = {
  enabled: true,
  // Aligned with hard floor — do not advertise a softer default than enforcement.
  minConfidence: CONFIDENCE_HARD_FLOOR,
  excludeTypes: [],
  maxEntriesPerSession: 50,
  deduplicationWindowMinutes: 30,
  analysisModel: process.env.AUTO_MEMORY_MODEL || 'claude-3-5-haiku-20241022',
};

function parseEnvNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** Normalize tags: lowercase, spaces→hyphen, drop empties, cap length/count. */
function normalizeTags(tags: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of tags) {
    const t = raw
      .toLowerCase()
      .trim()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9._/-]/g, '')
      .slice(0, TAG_LEN_MAX);
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= TAG_MAX) break;
  }
  return out;
}

export class AutoMemoryMiddleware {
  private config: AutoMemoryConfig;
  private anthropic: Anthropic | null = null;
  private readonly sessionEntries = new Map<string, number>();
  private readonly dedup: DedupStore;
  private purgeTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: Partial<AutoMemoryConfig> = {}, dedup?: DedupStore) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.dedup = dedup ?? createDedupStore();

    this.purgeTimer = setInterval(() => {
      try {
        this.dedup.purgeExpired();
      } catch {
        /* non-fatal */
      }
    }, 5 * 60_000);
    if (typeof this.purgeTimer === 'object' && 'unref' in this.purgeTimer) {
      this.purgeTimer.unref();
    }
  }

  private getAnthropic(): Anthropic {
    if (!this.anthropic) {
      if (!process.env.ANTHROPIC_API_KEY) {
        throw new AppError(
          'ANALYSIS_FAILED',
          'ANTHROPIC_API_KEY is not set; cannot run Auto-Memory analysis'
        );
      }
      this.anthropic = new Anthropic();
    }
    return this.anthropic;
  }

  /** Effective minimum confidence actually enforced at save time. */
  effectiveMinConfidence(): number {
    return Math.max(this.config.minConfidence, CONFIDENCE_HARD_FLOOR);
  }

  async processInteraction(
    request: string,
    response: string,
    source: MemorySource
  ): Promise<{ saved: boolean; entry?: AnalysisResult; reason?: string }> {
    if (!this.config.enabled) {
      return { saved: false, reason: 'disabled' };
    }

    const sessionKey = source.session_id || 'default';
    const count = this.sessionEntries.get(sessionKey) || 0;
    if (count >= this.config.maxEntriesPerSession) {
      return { saved: false, reason: 'session_rate_limit' };
    }

    const hash = contentHash(request + '\n---\n' + response);
    if (this.dedup.has(hash)) {
      return { saved: false, reason: 'duplicate' };
    }

    let analysis: AnalysisResult;
    try {
      analysis = await this.analyzeImportance(request, response);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(
        'ANALYSIS_FAILED',
        error instanceof Error ? error.message : 'Analysis failed'
      );
    }

    if (!analysis.isImportant) {
      // Distinguish model reject vs hard-floor override when possible
      if (analysis.confidence > 0 && analysis.confidence < CONFIDENCE_HARD_FLOOR) {
        return { saved: false, reason: 'below_hard_floor', entry: analysis };
      }
      return { saved: false, reason: 'model_rejected', entry: analysis };
    }

    const effectiveMin = this.effectiveMinConfidence();
    if (analysis.confidence < effectiveMin) {
      return {
        saved: false,
        reason:
          analysis.confidence < CONFIDENCE_HARD_FLOOR
            ? 'below_hard_floor'
            : 'below_config_threshold',
        entry: analysis,
      };
    }

    if (this.config.excludeTypes.includes(analysis.type)) {
      return { saved: false, reason: 'excluded_type', entry: analysis };
    }

    if (analysis.tags.length === 0) {
      return { saved: false, reason: 'empty_tags', entry: analysis };
    }

    const brain = getBrainClient();
    await brain.save({
      type: analysis.type,
      content: analysis.summary,
      tags: analysis.tags,
      source: { ...source, tool: source.tool === 'manual' ? 'manual' : 'auto-memory' },
      metadata: {
        confidence: analysis.confidence,
        originalRequest: request.substring(0, 500),
        context: analysis.context,
        contentHash: hash,
        effectiveMinConfidence: effectiveMin,
      },
    });

    // Record side effects only after successful persist
    this.sessionEntries.set(sessionKey, count + 1);
    this.dedup.add(hash, this.config.deduplicationWindowMinutes);

    return { saved: true, entry: analysis, reason: 'saved' };
  }

  private async analyzeImportance(request: string, response: string): Promise<AnalysisResult> {
    const userPayload = `REQUEST:\n${request.substring(0, 2200)}\n\nRESPONSE:\n${response.substring(0, 3200)}`;

    const message = await this.getAnthropic().messages.create({
      model: this.config.analysisModel,
      max_tokens: 400,
      system: CLASSIFIER_SYSTEM,
      messages: [{ role: 'user', content: userPayload }],
    });

    const block = message.content[0];
    if (!block || block.type !== 'text') {
      return this.defaultResult();
    }

    const jsonMatch = block.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return this.defaultResult();
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      return this.defaultResult();
    }

    const result = analysisSchema.safeParse(parsed);
    if (!result.success) {
      return this.defaultResult();
    }

    let isImportant = result.data.isImportant;
    const confidence = result.data.confidence;
    const tags = normalizeTags(result.data.tags);

    // Atomic post-condition: never trust model importance below hard floor
    if (confidence < CONFIDENCE_HARD_FLOOR) {
      isImportant = false;
    }

    // Important claims with zero usable tags are not retrieval-safe
    if (isImportant && tags.length === 0) {
      isImportant = false;
    }

    return {
      isImportant,
      type: result.data.type as MemoryType,
      summary: result.data.summary.substring(0, SUMMARY_MAX),
      tags,
      confidence,
      context: result.data.context,
    };
  }

  private defaultResult(): AnalysisResult {
    return {
      isImportant: false,
      type: 'context',
      summary: '',
      tags: [],
      confidence: 0,
    };
  }

  async saveDirectly(
    content: string,
    type: MemoryType,
    tags: string[],
    source: MemorySource
  ): Promise<void> {
    const brain = getBrainClient();
    await brain.save({ type, content, tags: normalizeTags(tags), source });
  }

  updateConfig(config: Partial<AutoMemoryConfig>): void {
    if (config.minConfidence !== undefined) {
      config.minConfidence = Math.min(1, Math.max(0, Number(config.minConfidence)));
    }
    if (config.maxEntriesPerSession !== undefined) {
      config.maxEntriesPerSession = Math.max(1, Math.floor(Number(config.maxEntriesPerSession)));
    }
    this.config = { ...this.config, ...config };
  }

  getStatus(): {
    config: AutoMemoryConfig;
    sessionCounts: Record<string, number>;
    dedupSize: number;
    confidenceHardFloor: number;
    effectiveMinConfidence: number;
  } {
    return {
      config: { ...this.config },
      sessionCounts: Object.fromEntries(this.sessionEntries),
      dedupSize: this.dedup.size(),
      confidenceHardFloor: CONFIDENCE_HARD_FLOOR,
      effectiveMinConfidence: this.effectiveMinConfidence(),
    };
  }

  close(): void {
    if (this.purgeTimer) {
      clearInterval(this.purgeTimer);
      this.purgeTimer = null;
    }
    this.dedup.close();
  }
}

let middleware: AutoMemoryMiddleware | null = null;

export function getAutoMemory(): AutoMemoryMiddleware {
  if (!middleware) {
    middleware = new AutoMemoryMiddleware({
      enabled: process.env.AUTO_MEMORY_ENABLED !== 'false',
      minConfidence: parseEnvNumber(
        process.env.AUTO_MEMORY_MIN_CONFIDENCE,
        CONFIDENCE_HARD_FLOOR
      ),
      analysisModel: process.env.AUTO_MEMORY_MODEL || 'claude-3-5-haiku-20241022',
    });
  }
  return middleware;
}

/** Test-only */
export function _resetAutoMemoryForTests(): void {
  if (middleware) middleware.close();
  middleware = null;
}

/** Exported for evaluation harness / unit tests (not part of MCP surface). */
export const _internal = {
  CONFIDENCE_HARD_FLOOR,
  normalizeTags,
  SUMMARY_MAX,
};
