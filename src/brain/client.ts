// Brain Client — HTTP boundary to Master Brain backend.
// Endpoint paths MUST match CONTRACTS/api_contract.md.
import type {
  BrainEntry,
  BrainStats,
  MemoryType,
  SearchResult,
} from '../types/index.js';
import { AppError } from '../lib/errors.js';

const DEFAULT_BRAIN_TIMEOUT_MS = 30_000;

function finitePositiveTimeout(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
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
    this.timeoutMs = finitePositiveTimeout(config.timeoutMs, DEFAULT_BRAIN_TIMEOUT_MS);
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
    return this.request<BrainEntry>('/api/brain/entries', {
      method: 'POST',
      headers: typeof key === 'string' ? { 'Idempotency-Key': key } : undefined,
      body: JSON.stringify(entry),
    });
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
    const timeoutMs = Number(process.env.BRAIN_TIMEOUT_MS) || 30_000;
    brainClient = new BrainClient({ baseUrl, apiKey, timeoutMs });
  }
  return brainClient;
}

/** Test-only: reset singleton. */
export function _resetBrainClientForTests(): void {
  brainClient = null;
}
