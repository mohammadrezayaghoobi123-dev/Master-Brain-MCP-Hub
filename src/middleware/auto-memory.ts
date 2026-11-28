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

/** Hard floor: model may claim importance, but below this we reject. */
const CONFIDENCE_HARD_FLOOR = 0.75;

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

    // Dual gate: model flag AND confidence (config + hard floor)
    const effectiveMin = Math.max(this.config.minConfidence, CONFIDENCE_HARD_FLOOR);
    if (!analysis.isImportant || analysis.confidence < effectiveMin) {
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

    this.sessionEntries.set(sessionKey, count + 1);
    this.dedup.add(hash, this.config.deduplicationWindowMinutes);

    return { saved: true, entry: analysis };
  }

  private async analyzeImportance(request: string, response: string): Promise<AnalysisResult> {
    const prompt = `You are a strict, high-precision Memory Importance Classifier for an engineering knowledge system (Master Brain).

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
- summary: max 180 characters, factual, no fluff
- tags: 1-5 items, lowercase, specific, no spaces
- confidence: calibrated probability in [0.0, 1.0]; be conservative
- type must be one of: decision | fix | learning | pattern | preference | config | error | context | conversation

### JSON shape
{
  "isImportant": boolean,
  "type": "decision" | "fix" | "learning" | "pattern" | "preference" | "config" | "error" | "context" | "conversation",
  "summary": "string",
  "tags": ["string"],
  "confidence": number,
  "context": "string (optional, max 300 chars)"
}

### Interaction to classify

REQUEST:
${request.substring(0, 2200)}

RESPONSE:
${response.substring(0, 3200)}
`;

    const message = await this.getAnthropic().messages.create({
      model: this.config.analysisModel,
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }],
    });

    const block = message.content[0];
    if (!block || block.type !== 'text') {
      return this.defaultResult('non_text_block');
    }

    const jsonMatch = block.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return this.defaultResult('no_json');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      return this.defaultResult('json_parse_error');
    }

    const result = analysisSchema.safeParse(parsed);
    if (!result.success) {
      return this.defaultResult('schema_validation_failed');
    }

    let isImportant = result.data.isImportant;
    const confidence = result.data.confidence;

    // Atomic post-condition: never trust model importance below hard floor
    if (confidence < CONFIDENCE_HARD_FLOOR) {
      isImportant = false;
    }

    return {
      isImportant,
      type: result.data.type as MemoryType,
      summary: result.data.summary.substring(0, 180),
      tags: result.data.tags.slice(0, 5).map((t) => t.toLowerCase().trim()),
      confidence,
      context: result.data.context,
    };
  }

  private defaultResult(_reason?: string): AnalysisResult {
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
