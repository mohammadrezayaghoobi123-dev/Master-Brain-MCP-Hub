// MCP Tool: brain_recent
import { z } from 'zod';
import { getBrainClient } from '../brain/client.js';
import type { MCPToolResult, MemoryType } from '../types/index.js';
import { MEMORY_TYPES } from '../types/index.js';
import { toStructuredError } from '../lib/errors.js';

export const recentSchema = z.object({
  limit: z.number().min(1).max(50).optional().default(10).describe('Anzahl der Einträge'),
  type: z.enum(MEMORY_TYPES).optional().describe('Filtern nach Typ'),
});

export type RecentInput = z.infer<typeof recentSchema>;

export async function brainRecent(input: RecentInput): Promise<MCPToolResult> {
  try {
    const brain = getBrainClient();
    const entries = await brain.recent(input.limit, input.type as MemoryType | undefined);

    return {
      success: true,
      data: {
        count: entries.length,
        entries: entries.map((e) => ({
          id: e.id,
          type: e.type,
          content: e.content,
          summary: e.summary,
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

export const recentToolDefinition = {
  name: 'brain_recent',
  description: 'Zeigt die neuesten Einträge im Master Brain.',
  inputSchema: {
    type: 'object',
    properties: {
      limit: {
        type: 'number',
        default: 10,
        description: 'Anzahl der Einträge (1-50)',
      },
      type: {
        type: 'string',
        enum: [...MEMORY_TYPES],
        description: 'Filtern nach Typ (optional)',
      },
    },
    required: [] as string[],
  },
};
