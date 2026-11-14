// Real-socket regression tests (no fetch mocks). They exercise Undici transport behavior
// on every Node version in the CI matrix and falsify the redirect/pre-dispatch classification.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { BrainClient, _resetBrainClientForTests } from '../src/brain/client.js';
import { AppError } from '../src/lib/errors.js';
import { AutoMemoryMiddleware } from '../src/middleware/auto-memory.js';
import { createMemoryDedupStore } from '../src/lib/dedup-store.js';

const ENTRY = {
  type: 'decision' as const,
  content: 'c',
  tags: [],
  source: { tool: 'api' as const },
};

/** A loopback port that was just free, so a connect attempt yields a genuine ECONNREFUSED. */
async function closedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

async function failure(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('expected the request to fail');
}

describe('BrainClient — real socket transport classification', () => {
  let servers: Server[] = [];
  const savedEnv = { url: process.env.BRAIN_API_URL, timeout: process.env.BRAIN_TIMEOUT_MS };

  beforeEach(() => {
    servers = [];
  });

  afterEach(async () => {
    for (const server of servers) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (savedEnv.url === undefined) delete process.env.BRAIN_API_URL;
    else process.env.BRAIN_API_URL = savedEnv.url;
    if (savedEnv.timeout === undefined) delete process.env.BRAIN_TIMEOUT_MS;
    else process.env.BRAIN_TIMEOUT_MS = savedEnv.timeout;
    _resetBrainClientForTests();
  });

  it('marks a genuine ECONNREFUSED on a closed loopback port as not_dispatched', async () => {
    const port = await closedPort();
    const client = new BrainClient({ baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 2000 });
    const error = await failure(client.save(ENTRY));
    expect(error.code).toBe('BRAIN_UNREACHABLE');
    expect(error.details?.networkCode).toBe('ECONNREFUSED');
    expect(error.details?.requestDisposition).toBe('not_dispatched');
  });

  it('marks a real DNS ENOTFOUND from a reserved .invalid hostname as not_dispatched', async () => {
    const host = `pr5-${randomUUID()}.invalid`;
    const client = new BrainClient({ baseUrl: `http://${host}`, timeoutMs: 5000 });
    const error = await failure(client.save(ENTRY));
    expect(error.details?.networkCode).toBe('ENOTFOUND');
    expect(error.details?.requestDisposition).toBe('not_dispatched');
  });

  it('never follows a redirect on a write: the first hop received the body, so it is NOT pre-dispatch', async () => {
    const deadPort = await closedPort();
    let received = 0;
    const server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        received += 1;
        res.writeHead(307, { Location: `http://127.0.0.1:${deadPort}/api/brain/entries` });
        res.end();
      });
    });
    servers.push(server);
    const port = await listen(server);

    const client = new BrainClient({ baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 2000 });
    const error = await failure(client.save(ENTRY));
    expect(received).toBe(1);
    expect(error.details?.requestDisposition).toBeUndefined();
  });

  it('keeps UNKNOWN and sends exactly one request when a write is redirected to an unreachable target', async () => {
    const deadPort = await closedPort();
    let received = 0;
    const server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        received += 1;
        res.writeHead(307, { Location: `http://127.0.0.1:${deadPort}/api/brain/entries` });
        res.end();
      });
    });
    servers.push(server);
    const port = await listen(server);
    process.env.BRAIN_API_URL = `http://127.0.0.1:${port}`;
    process.env.BRAIN_TIMEOUT_MS = '2000';
    _resetBrainClientForTests();

    const middleware = new AutoMemoryMiddleware({ enabled: true }, createMemoryDedupStore());
    (middleware as unknown as { analyzeImportance: () => Promise<unknown> }).analyzeImportance = async () => ({
      isImportant: true,
      type: 'decision',
      summary: 's',
      tags: [],
      confidence: 0.95,
    });

    try {
      await expect(middleware.processInteraction('redirect-req', 'redirect-res', { tool: 'api' })).rejects.toMatchObject({ code: 'BRAIN_UNREACHABLE' });
      const retry = await middleware.processInteraction('redirect-req', 'redirect-res', { tool: 'api' });
      expect(retry).toMatchObject({ saved: false, reason: 'outcome_unknown', retryable: false });
      expect(received).toBe(1);
    } finally {
      middleware.close();
    }
  });

  it('still follows redirects for read-only GET requests', async () => {
    const target = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', version: 'x' }));
    });
    servers.push(target);
    const targetPort = await listen(target);
    const front = createServer((_req, res) => {
      res.writeHead(302, { Location: `http://127.0.0.1:${targetPort}/api/brain/health` });
      res.end();
    });
    servers.push(front);
    const frontPort = await listen(front);

    const client = new BrainClient({ baseUrl: `http://127.0.0.1:${frontPort}`, timeoutMs: 2000 });
    await expect(client.health()).resolves.toMatchObject({ ok: true });
  });
});
