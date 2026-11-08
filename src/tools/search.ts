// MCP Tool: brain_search
import { z } from 'zod';
import { getBrainClient } from '../brain/client.js';
import type { MCPToolResult } from '../types/index.js';
import { MEMORY_TYPES } from '../types/index.js';
import { toStructuredError } from '../lib/errors.js';

export const searchSchema = z.object({
  query: z.string().min(1).describe('Suchbegriff oder Frage'),
  mode: z
    .enum(['semantic', 'keyword', 'hybrid'])
    .optional()
    .default('hybrid')
    .describe('Suchmodus'),
  type: z.enum(MEMORY_TYPES).optional().describe('Filtern nach Typ'),
  tags: z.array(z.string()).optional().describe('Filtern nach Tags'),
  limit: z.number().min(1).max(50).optional().default(10).describe('Max. Ergebnisse'),
});

export type SearchInput = z.infer<typeof searchSchema>;

export async function brainSearch(input: SearchInput): Promise<MCPToolResult> {
  try {
    const brain = getBrainClient();
    const result = await brain.search(input.query, {
      mode: input.mode,
      type: input.type,
      tags: input.tags,
      limit: input.limit,
    });

    return {
      success: true,
      data: {
        query: result.query,
        mode: result.mode,
        total: result.total,
        entries: result.entries.map((e) => ({
          id: e.id,
          type: e.type,
          content: e.content,
          tags: e.tags,
          timestamp: e.timestamp,
          source: e.source,
        })),
      },
    };
  } catch (error) {
    return { success: false, error: toStructuredError(error) };
  }
}

export const searchToolDefinition = {
  name: 'brain_search',
  description:
    'Durchsucht das Master Brain nach gespeichertem Wissen (semantic / keyword / hybrid).',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Suchbegriff oder Frage' },
      mode: {
        type: 'string',
        enum: ['semantic', 'keyword', 'hybrid'],
        default: 'hybrid',
        description: 'Suchmodus',
      },
      type: {
        type: 'string',
        enum: [...MEMORY_TYPES],
        description: 'Filtern nach Typ (optional)',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Filtern nach Tags (optional)',
      },
      limit: {
        type: 'number',
        default: 10,
        description: 'Max. Ergebnisse (1-50)',
      },
    },
    required: ['query'],
  },
};
