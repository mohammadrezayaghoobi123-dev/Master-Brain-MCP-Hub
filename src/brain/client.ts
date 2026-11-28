// Brain Client — HTTP boundary to Master Brain backend.
// Endpoint paths and headers MUST match CONTRACTS/api_contract.md.
import { randomUUID } from 'node:crypto';
import type {
  BrainEntry,
  BrainStats,
  MemoryType,
  SearchResult,
} from '../types/index.js';
import { AppError } from '../lib/errors.js';

export interface BrainClientConfig {
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
  /** Max total attempts for retryable requests (default 3). */
  maxAttempts?: number;
}

export type HealthStatus =
  | { ok: true; version?: string }
  | {
      ok: false;
      reason: 'unreachable' | 'timeout' | 'http_error' | 'invalid_payload';
      status?: number;
      message?: string;
    };

export interface SaveOptions {
  /**
   * Stable key for at-least-once safe retries.
   * If omitted, a fresh UUID is generated (retries still safe for that single call).
   */
  idempotencyKey?: string;
}

interface RequestOptions extends RequestInit {
  /** When true, transient failures may be retried (only safe with idempotent semantics). */
  retryable?: boolean;
  /** Extra headers merged after defaults. */
  extraHeaders?: Record<string, string>;
}

const RETRYABLE_STATUS = new Set([502, 503, 504]);

function parseEnvNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class BrainClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;

  constructor(config: BrainClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.maxAttempts = Math.max(1, config.maxAttempts ?? 3);
  }

  private async requestOnce<T>(endpoint: string, options: RequestOptions = {}): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(options.extraHeaders ?? {}),
      ...((options.headers as Record<string, string> | undefined) ?? {}),
    };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        method: options.method,
        body: options.body,
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
          throw new AppError('RATE_LIMITED', message, {
            status: response.status,
            endpoint,
            retryAfter: response.headers.get('retry-after') ?? undefined,
          });
        }
        throw new AppError('BRAIN_HTTP_ERROR', message, {
          status: response.status,
          endpoint,
          code: typeof body.code === 'string' ? body.code : undefined,
        });
      }

      // 204 / empty body
      if (response.status === 204) {
        return undefined as T;
      }

      const text = await response.text();
      if (!text) {
        return undefined as T;
      }
      return JSON.parse(text) as T;
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new AppError('TIMEOUT', `Brain request timed out after ${this.timeoutMs}ms`, {
          endpoint,
        });
      }
      if (error instanceof SyntaxError) {
        throw new AppError('BRAIN_HTTP_ERROR', 'Invalid JSON from Brain', { endpoint });
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

  private async request<T>(endpoint: string, options: RequestOptions = {}): Promise<T> {
    const retryable = options.retryable === true;
    const attempts = retryable ? this.maxAttempts : 1;
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await this.requestOnce<T>(endpoint, options);
      } catch (error) {
        lastError = error;
        const canRetry =
          retryable &&
          attempt < attempts &&
          error instanceof AppError &&
          (error.code === 'BRAIN_UNREACHABLE' ||
            error.code === 'TIMEOUT' ||
            (error.code === 'BRAIN_HTTP_ERROR' &&
              typeof error.details?.status === 'number' &&
              RETRYABLE_STATUS.has(error.details.status as number)));

        if (!canRetry) throw error;

        // Exponential backoff: 200ms, 400ms, … capped
        const delayMs = Math.min(200 * 2 ** (attempt - 1), 2_000);
        await sleep(delayMs);
      }
    }

    throw lastError;
  }

  async save(
    entry: Omit<BrainEntry, 'id' | 'timestamp'>,
    options: SaveOptions = {}
  ): Promise<BrainEntry> {
    const idempotencyKey = options.idempotencyKey?.trim() || randomUUID();

    return this.request<BrainEntry>('/api/brain/entries', {
      method: 'POST',
      body: JSON.stringify(entry),
      retryable: true,
      extraHeaders: {
        'Idempotency-Key': idempotencyKey,
      },
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

    return this.request<SearchResult>(`/api/brain/search?${params}`, {
      method: 'GET',
      retryable: true,
    });
  }

  async stats(): Promise<BrainStats> {
    return this.request<BrainStats>('/api/brain/stats', {
      method: 'GET',
      retryable: true,
    });
  }

  async recent(limit = 10, type?: MemoryType): Promise<BrainEntry[]> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (type) params.set('type', type);
    return this.request<BrainEntry[]>(`/api/brain/recent?${params}`, {
      method: 'GET',
      retryable: true,
    });
  }

  async delete(id: string): Promise<void> {
    // DELETE is not retried automatically (not all backends treat it as idempotent).
    await this.request(`/api/brain/entries/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      retryable: false,
    });
  }

  async health(): Promise<HealthStatus> {
    try {
      const result = await this.requestOnce<{ status?: string; version?: string }>(
        '/api/brain/health',
        { method: 'GET' }
      );
      if (!result || result.status !== 'ok') {
        return {
          ok: false,
          reason: 'invalid_payload',
          message: result ? `unexpected status=${String(result.status)}` : 'empty body',
        };
      }
      return { ok: true, version: result.version };
    } catch (error) {
      if (error instanceof AppError) {
        if (error.code === 'TIMEOUT') {
          return { ok: false, reason: 'timeout', message: error.message };
        }
        if (error.code === 'BRAIN_HTTP_ERROR') {
          return {
            ok: false,
            reason: 'http_error',
            status: typeof error.details?.status === 'number' ? error.details.status : undefined,
            message: error.message,
          };
        }
        return { ok: false, reason: 'unreachable', message: error.message };
      }
      return {
        ok: false,
        reason: 'unreachable',
        message: error instanceof Error ? error.message : 'unknown',
      };
    }
  }
}

let brainClient: BrainClient | null = null;

export function getBrainClient(): BrainClient {
  if (!brainClient) {
    const baseUrl = process.env.BRAIN_API_URL || 'http://localhost:3001';
    const apiKey = process.env.BRAIN_API_KEY || undefined;
    const timeoutMs = parseEnvNumber(process.env.BRAIN_TIMEOUT_MS, 30_000);
    const maxAttempts = parseEnvNumber(process.env.BRAIN_MAX_ATTEMPTS, 3);
    brainClient = new BrainClient({ baseUrl, apiKey, timeoutMs, maxAttempts });
  }
  return brainClient;
}

/** Test-only: reset singleton. */
export function _resetBrainClientForTests(): void {
  brainClient = null;
}
