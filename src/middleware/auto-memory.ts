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

const DEFAULT_CONFIG: AutoMemoryConfig = {
  enabled: true,
  minConfidence: 0.7,
  excludeTypes: [],
  maxEntriesPerSession: 50,
  deduplicationWindowMinutes: 30,
  analysisModel: process.env.AUTO_MEMORY_MODEL || 'claude-3-5-haiku-20241022',
};

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
    if (!this.dedup.claim(hash, this.config.deduplicationWindowMinutes)) {
      return { saved: false, reason: 'duplicate' };
    }

    let persisted = false;
    try {
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

      // Start the deduplication window after the durable save succeeds.
      this.dedup.add(hash, this.config.deduplicationWindowMinutes);
      this.sessionEntries.set(sessionKey, count + 1);
      persisted = true;
      return { saved: true, entry: analysis };
    } finally {
      if (!persisted) {
        try {
          this.dedup.release(hash);
        } catch {
          // Preserve the original analysis/save outcome; the reservation expires by TTL.
        }
      }
    }
  }

  private async analyzeImportance(request: string, response: string): Promise<AnalysisResult> {
    const prompt = `Analysiere diese AI-Interaktion und bestimme ob sie fuer langfristiges Wissen gespeichert werden sollte.\n\nREQUEST:\n${request.substring(0, 2000)}\n\nRESPONSE:\n${response.substring(0, 3000)}\n\nAntworte NUR mit validem JSON in diesem Format:\n{\n  "isImportant": boolean,\n  "type": "decision" | "fix" | "learning" | "pattern" | "preference" | "config" | "error" | "context" | "conversation",\n  "summary": "Kurze Zusammenfassung (max 200 Zeichen)",\n  "tags": ["tag1", "tag2", "tag3"],\n  "confidence": 0.0-1.0,\n  "context": "Optional: Warum ist das wichtig?"\n}\n\nRegeln:\n- isImportant=true NUR wenn: Entscheidung, Bug-Fix, Learning, Pattern, Preference, Config\n- isImportant=false fuer Smalltalk und einfache Fragen\n- confidence: 0.9+ sehr wichtig, 0.7-0.9 wichtig, <0.7 nicht speichern\n- tags: max 5, lowercase`;

    const message = await this.getAnthropic().messages.create({
      model: this.config.analysisModel,
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }],
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
    this.config = { ...this.config, ...config };
  }

  getStatus(): {
    config: AutoMemoryConfig;
    sessionCounts: Record<string, number>;
    dedupSize: number;
  } {
    return {
      config: { ...this.config },
      sessionCounts: Object.fromEntries(this.sessionEntries),
      dedupSize: this.dedup.size(),
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
