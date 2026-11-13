// Auto-Memory Middleware
// Analyses interactions and persists only high-confidence durable knowledge.
//
// Design constraint (MCP stdio): this process cannot silently observe the
// full LLM conversation. Callers (agent hooks, SessionEnd, or the agent
// itself) MUST invoke processInteraction / the brain_observe tool explicitly.

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

const analysisSchema = z.object({
  isImportant: z.boolean(),
  type: z.enum(MEMORY_TYPES),
  summary: z.string().min(1).max(200),
  tags: z.array(z.string().min(1).max(64)).max(5),
  confidence: z.number().min(0).max(1),
  context: z.string().max(500).optional(),
});

function finitePositiveTimeout(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

const DEFAULT_CONFIG: AutoMemoryConfig = {
  enabled: true,
  minConfidence: 0.7,
  excludeTypes: [],
  maxEntriesPerSession: 50,
  deduplicationWindowMinutes: 30,
  claimLeaseMinutes: 2,
  analysisTimeoutMs: 60_000,
  analysisModel: process.env.AUTO_MEMORY_MODEL || 'claude-3-5-haiku-20241022',
};

export class AutoMemoryMiddleware {
  private config: AutoMemoryConfig;
  private anthropic: Anthropic | null = null;
  private readonly sessionEntries = new Map<string, number>();
  // Reserve session capacity before the first await so concurrent interactions
  // cannot all pass the same stale persisted-count check.
  private readonly sessionReservations = new Map<string, number>();
  private readonly dedup: DedupStore;
  private purgeTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: Partial<AutoMemoryConfig> = {}, dedup?: DedupStore) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.config.analysisTimeoutMs = finitePositiveTimeout(
      this.config.analysisTimeoutMs,
      DEFAULT_CONFIG.analysisTimeoutMs
    );
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

  async processInteraction(
    request: string,
    response: string,
    source: MemorySource
  ): Promise<{ saved: boolean; entry?: AnalysisResult; reason?: string; retryable?: boolean }> {
    if (!this.config.enabled) {
      return { saved: false, reason: 'disabled' };
    }

    const sessionKey = source.session_id || 'default';
    const count = this.sessionEntries.get(sessionKey) || 0;
    const reserved = this.sessionReservations.get(sessionKey) || 0;
    if (count + reserved >= this.config.maxEntriesPerSession) {
      return { saved: false, reason: 'session_rate_limit' };
    }

    // This reservation is synchronous and therefore atomic within this
    // middleware instance, including across async analysis/save boundaries.
    this.sessionReservations.set(sessionKey, reserved + 1);
    const hash = contentHash(request + '\n---\n' + response);
    let reservationToken: string | null = null;
    let persisted = false;
    // Once dispatch may begin, the claim is durably quarantined as UNKNOWN and
    // is never released or expired automatically.
    let keepClaim = false;

    try {
      reservationToken = this.dedup.claim(hash, this.effectiveLeaseMinutes());
      if (reservationToken === null) {
        const state = this.dedup.status(hash);
        if (state === 'committed') return { saved: false, reason: 'duplicate' };
        if (state === 'unknown') {
          return { saved: false, reason: 'outcome_unknown', retryable: false };
        }
        return { saved: false, reason: 'duplicate_in_flight', retryable: true };
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

      if (!analysis.isImportant || analysis.confidence < this.config.minConfidence) {
        return { saved: false, reason: 'below_threshold', entry: analysis };
      }

      if (this.config.excludeTypes.includes(analysis.type)) {
        return { saved: false, reason: 'excluded_type', entry: analysis };
      }

      const brain = getBrainClient();
      // Establish durable quarantine before invoking the external side effect.
      // If ownership was lost or the transition cannot be confirmed, fail closed:
      // no Brain request is dispatched.
      if (!this.dedup.markUnknown(hash, reservationToken)) {
        return { saved: false, reason: 'claim_lost', retryable: false };
      }
      keepClaim = true;
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
        },
      });

      // The brain save is durable at this point: promote the claim to committed
      // and account for the entry even if the dedup store misbehaves.
      persisted = true;
      const currentCount = this.sessionEntries.get(sessionKey) || 0;
      this.sessionEntries.set(sessionKey, currentCount + 1);
      try {
        const committed = this.dedup.commit(
          hash,
          reservationToken,
          this.config.deduplicationWindowMinutes
        );
        if (!committed) {
          this.logDedupError(
            'commit',
            new Error('Confirmed Brain save could not commit the matching UNKNOWN owner row')
          );
        }
      } catch (err) {
        // Keep UNKNOWN if local durable finalization fails. Never use an
        // owner-blind UPSERT to overwrite another claim or erase quarantine.
        this.logDedupError('commit', err);
      }
      return { saved: true, entry: analysis };
    } finally {
      const currentReserved = this.sessionReservations.get(sessionKey) || 0;
      if (currentReserved <= 1) this.sessionReservations.delete(sessionKey);
      else this.sessionReservations.set(sessionKey, currentReserved - 1);

      if (reservationToken !== null && !persisted && !keepClaim) {
        try {
          this.dedup.release(hash, reservationToken);
        } catch (err) {
          // Preserve the original analysis/save outcome; the reservation expires with its lease.
          this.logDedupError('release', err);
        }
      }
    }
  }

  /**
   * The lease must outlive the worst-case processing time (analysis + brain save);
   * otherwise a claim could expire mid-flight and let a second interaction duplicate it.
   */
  private effectiveLeaseMinutes(): number {
    const brainTimeoutMs = finitePositiveTimeout(Number(process.env.BRAIN_TIMEOUT_MS), 30_000);
    const analysisMs = finitePositiveTimeout(this.config.analysisTimeoutMs, DEFAULT_CONFIG.analysisTimeoutMs);
    const configuredLeaseMs = finitePositiveTimeout(this.config.claimLeaseMinutes, 2) * 60_000;
    return Math.max(configuredLeaseMs, analysisMs + brainTimeoutMs + 1_000) / 60_000;
  }

  private logDedupError(op: string, err: unknown): void {
    console.error(
      `[AutoMemory] dedup ${op} failed (non-fatal):`,
      err instanceof Error ? err.message : err
    );
  }

  private async analyzeImportance(request: string, response: string): Promise<AnalysisResult> {
    const prompt = `Analysiere diese AI-Interaktion und bestimme ob sie fuer langfristiges Wissen gespeichert werden sollte.\n\nREQUEST:\n${request.substring(0, 2000)}\n\nRESPONSE:\n${response.substring(0, 3000)}\n\nAntworte NUR mit validem JSON in diesem Format:\n{\n  "isImportant": boolean,\n  "type": "decision" | "fix" | "learning" | "pattern" | "preference" | "config" | "error" | "context" | "conversation",\n  "summary": "Kurze Zusammenfassung (max 200 Zeichen)",\n  "tags": ["tag1", "tag2", "tag3"],\n  "confidence": 0.0-1.0,\n  "context": "Optional: Warum ist das wichtig?"\n}\n\nRegeln:\n- isImportant=true NUR wenn: Entscheidung, Bug-Fix, Learning, Pattern, Preference, Config\n- isImportant=false fuer Smalltalk und einfache Fragen\n- confidence: 0.9+ sehr wichtig, 0.7-0.9 wichtig, <0.7 nicht speichern\n- tags: max 5, lowercase`;

    const message = await this.getAnthropic().messages.create(
      {
        model: this.config.analysisModel,
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }],
      },
      { timeout: this.config.analysisTimeoutMs, maxRetries: 0 }
    );

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

    return {
      isImportant: result.data.isImportant,
      type: result.data.type as MemoryType,
      summary: result.data.summary.substring(0, 200),
      tags: result.data.tags.slice(0, 5).map((t) => t.toLowerCase().trim()),
      confidence: result.data.confidence,
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
    await brain.save({ type, content, tags, source });
  }

  updateConfig(config: Partial<AutoMemoryConfig>): void {
    if (config.minConfidence !== undefined) {
      config.minConfidence = Math.min(1, Math.max(0, Number(config.minConfidence)));
    }
    if (config.maxEntriesPerSession !== undefined) {
      config.maxEntriesPerSession = Math.max(1, Math.floor(Number(config.maxEntriesPerSession)));
    }
    const normalized = { ...config };
    if (normalized.analysisTimeoutMs !== undefined) {
      normalized.analysisTimeoutMs = finitePositiveTimeout(
        normalized.analysisTimeoutMs,
        DEFAULT_CONFIG.analysisTimeoutMs
      );
    }
    this.config = { ...this.config, ...normalized };
  }

  getStatus(): {
    config: AutoMemoryConfig;
    sessionCounts: Record<string, number>;
    dedupSize: number;
    dedupBackend: 'sqlite' | 'memory';
  } {
    return {
      config: { ...this.config },
      sessionCounts: Object.fromEntries(this.sessionEntries),
      dedupSize: this.dedup.size(),
      dedupBackend: this.dedup.backend,
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
      minConfidence: Number(process.env.AUTO_MEMORY_MIN_CONFIDENCE) || 0.7,
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
