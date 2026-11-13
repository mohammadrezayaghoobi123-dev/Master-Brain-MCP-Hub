// Brain Client — HTTP boundary to Master Brain backend.
// Endpoint paths MUST match CONTRACTS/api_contract.md.
import type {
  BrainEntry,
  BrainStats,
  MemoryType,
  SearchResult,
} from '../types/index.js';
import { MEMORY_TYPES } from '../types/index.js';
import { AppError } from '../lib/errors.js';
import {
  assertPositiveSafeIntegerMs,
  DEFAULT_BRAIN_TIMEOUT_MS,
  parsePositiveSafeIntegerEnv,
} from '../lib/time-budget.js';


const MEMORY_SOURCE_TOOLS = new Set([
  'claude-code',
  'codex',
  'cursor',
  'api',
  'manual',
  'auto-memory',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The API contract requires a complete BrainEntry before a save is treated as confirmed. */
function isBrainEntry(value: unknown): value is BrainEntry {
  if (!isRecord(value)) return false;
  if (typeof value.id !== 'string' || value.id.trim().length === 0) return false;
  if (typeof value.type !== 'string' || !MEMORY_TYPES.includes(value.type as MemoryType)) return false;
  if (typeof value.content !== 'string') return false;
  if (!Array.isArray(value.tags) || !value.tags.every((tag) => typeof tag === 'string')) return false;
  if (!isRecord(value.source) || typeof value.source.tool !== 'string') return false;
  if (!MEMORY_SOURCE_TOOLS.has(value.source.tool)) return false;

  const source = value.source as Record<string, unknown>;
  for (const key of ['session_id', 'project', 'file', 'user_id'] as const) {
    if (source[key] !== undefined && typeof source[key] !== 'string') return false;
  }
  if (typeof value.timestamp !== 'string') return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value.timestamp)) return false;
  if (!Number.isFinite(Date.parse(value.timestamp))) return false;
  if (value.summary !== undefined && typeof value.summary !== 'string') return false;
  if (value.metadata !== undefined && !isRecord(value.metadata)) return false;
  return true;
}

export interface BrainClientConfig {
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
}

export class BrainClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;

  constructor(config: BrainClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.apiKey = config.apiKey;
    this.timeoutMs =
      config.timeoutMs === undefined
        ? DEFAULT_BRAIN_TIMEOUT_MS
        : assertPositiveSafeIntegerMs(config.timeoutMs, 'BrainClient timeoutMs');
  }

  private async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(options.headers as Record<string, string> | undefined),
    };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        ...options,
        headers,
        signal: controller.signal,
      });

      if (!response.ok) {
        let body: Record<string, unknown> = {};
        try {
          body = (await response.json()) as Record<string, unknown>;
        } catch {
          /* non-JSON body */
        }
        const message =
          (typeof body.message === 'string' && body.message) ||
          (typeof body.error === 'string' && body.error) ||
          `HTTP ${response.status}`;

        if (response.status === 429) {
          throw new AppError('RATE_LIMITED', message, { status: response.status });
        }
        throw new AppError('BRAIN_HTTP_ERROR', message, {
          status: response.status,
          endpoint,
        });
      }

      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new AppError('TIMEOUT', `Brain request timed out after ${this.timeoutMs}ms`, {
          endpoint,
        });
      }
      throw new AppError(
        'BRAIN_UNREACHABLE',
        error instanceof Error ? error.message : 'Brain unreachable',
        { endpoint }
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async save(entry: Omit<BrainEntry, 'id' | 'timestamp'>): Promise<BrainEntry> {
    // Lets an idempotency-aware backend collapse retries of an ambiguous save
    // (timeout / lost response). Ignored by backends that do not support it.
    const key = entry.metadata?.contentHash;
    const result = await this.request<unknown>('/api/brain/entries', {
      method: 'POST',
      headers: typeof key === 'string' ? { 'Idempotency-Key': key } : undefined,
      body: JSON.stringify(entry),
    });
    if (!isBrainEntry(result)) {
      throw new AppError('BRAIN_HTTP_ERROR', 'Brain returned an invalid BrainEntry response', {
        endpoint: '/api/brain/entries',
      });
    }
    return result;
  }

  async search(
    query: string,
    options?: {
      mode?: 'semantic' | 'keyword' | 'hybrid';
      type?: MemoryType;
      tags?: string[];
      limit?: number;
    }
  ): Promise<SearchResult> {
    const params = new URLSearchParams({
      q: query,
      mode: options?.mode ?? 'hybrid',
      limit: String(options?.limit ?? 10),
    });
    if (options?.type) params.set('type', options.type);
    if (options?.tags?.length) params.set('tags', options.tags.join(','));

    return this.request<SearchResult>(`/api/brain/search?${params}`);
  }

  async stats(): Promise<BrainStats> {
    return this.request<BrainStats>('/api/brain/stats');
  }

  async recent(limit = 10, type?: MemoryType): Promise<BrainEntry[]> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (type) params.set('type', type);
    return this.request<BrainEntry[]>(`/api/brain/recent?${params}`);
  }

  async delete(id: string): Promise<void> {
    await this.request(`/api/brain/entries/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }

  async health(): Promise<{ ok: boolean; version?: string }> {
    try {
      const result = await this.request<{ status: string; version?: string }>(
        '/api/brain/health'
      );
      return { ok: result.status === 'ok', version: result.version };
    } catch {
      return { ok: false };
    }
  }
}

let brainClient: BrainClient | null = null;

export function getBrainClient(): BrainClient {
  if (!brainClient) {
    const baseUrl = process.env.BRAIN_API_URL || 'http://localhost:3001';
    const apiKey = process.env.BRAIN_API_KEY || undefined;
    const timeoutMs = parsePositiveSafeIntegerEnv('BRAIN_TIMEOUT_MS', DEFAULT_BRAIN_TIMEOUT_MS);
    brainClient = new BrainClient({ baseUrl, apiKey, timeoutMs });
  }
  return brainClient;
}

/** Test-only: reset singleton. */
export function _resetBrainClientForTests(): void {
  brainClient = null;
}
