// MCP Tool: brain_observe
// Explicit ingestion path for Auto-Memory (hooks / agents must call this).
import { z } from 'zod';
import { getAutoMemory } from '../middleware/auto-memory.js';
import type { MCPToolResult, MemorySource } from '../types/index.js';
import { toStructuredError } from '../lib/errors.js';

export const observeSchema = z.object({
  request: z.string().min(1).max(20_000).describe('User / agent request text'),
  response: z.string().min(1).max(50_000).describe('Model / tool response text'),
  session_id: z.string().max(128).optional().describe('Session identifier for rate limits'),
  project: z.string().max(256).optional().describe('Optional project name'),
  tool: z
    .enum(['claude-code', 'codex', 'cursor', 'api', 'manual'])
    .optional()
    .default('claude-code')
    .describe('Originating tool'),
});

export type ObserveInput = z.infer<typeof observeSchema>;

export async function brainObserve(input: ObserveInput): Promise<MCPToolResult> {
  try {
    const autoMemory = getAutoMemory();
    const source: MemorySource = {
      tool: input.tool,
      session_id: input.session_id,
      project: input.project,
    };

    const result = await autoMemory.processInteraction(
      input.request,
      input.response,
      source
    );

    return {
      success: true,
      data: {
        saved: result.saved,
        reason: result.reason ?? (result.saved ? 'saved' : 'skipped'),
        entry: result.entry
          ? {
              type: result.entry.type,
              summary: result.entry.summary,
              tags: result.entry.tags,
              confidence: result.entry.confidence,
            }
          : undefined,
      },
    };
  } catch (error) {
    return { success: false, error: toStructuredError(error) };
  }
}

export const observeToolDefinition = {
  name: 'brain_observe',
  description:
    'Feeds a request/response pair into Auto-Memory for importance analysis and conditional persistence. Required because MCP stdio cannot passively observe conversations — call from SessionEnd hooks or when a durable decision/fix/learning occurred.',
  inputSchema: {
    type: 'object',
    properties: {
      request: {
        type: 'string',
        description: 'User / agent request text',
      },
      response: {
        type: 'string',
        description: 'Model / tool response text',
      },
      session_id: {
        type: 'string',
        description: 'Session id for per-session rate limiting (optional)',
      },
      project: {
        type: 'string',
        description: 'Project name (optional)',
      },
      tool: {
        type: 'string',
        enum: ['claude-code', 'codex', 'cursor', 'api', 'manual'],
        default: 'claude-code',
        description: 'Originating client tool',
      },
    },
    required: ['request', 'response'],
  },
};
