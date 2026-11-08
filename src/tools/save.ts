// MCP Tool: brain_save
import { z } from 'zod';
import { getBrainClient } from '../brain/client.js';
import type { MCPToolResult, MemoryType } from '../types/index.js';
import { MEMORY_TYPES } from '../types/index.js';
import { toStructuredError } from '../lib/errors.js';

export const saveSchema = z.object({
  content: z.string().min(1).max(10_000).describe('Der zu speichernde Inhalt'),
  type: z.enum(MEMORY_TYPES).describe('Art des Eintrags'),
  tags: z.array(z.string()).min(1).max(10).describe('Tags für die Suche (1-10)'),
  summary: z.string().max(200).optional().describe('Kurze Zusammenfassung'),
  project: z.string().optional().describe('Projekt-Name'),
});

export type SaveInput = z.infer<typeof saveSchema>;

export async function brainSave(input: SaveInput): Promise<MCPToolResult> {
  try {
    const brain = getBrainClient();

    const entry = await brain.save({
      type: input.type as MemoryType,
      content: input.content,
      summary: input.summary,
      tags: input.tags.map((t) => t.toLowerCase().trim()),
      source: {
        tool: 'claude-code',
        project: input.project,
      },
    });

    return {
      success: true,
      data: {
        id: entry.id,
        type: entry.type,
        tags: entry.tags,
        message: `Erfolgreich gespeichert: ${input.type}`,
      },
    };
  } catch (error) {
    return { success: false, error: toStructuredError(error) };
  }
}

export const saveToolDefinition = {
  name: 'brain_save',
  description:
    'Speichert Wissen im Master Brain (Entscheidungen, Fixes, Learnings, Patterns, Prefs, Configs).',
  inputSchema: {
    type: 'object',
    properties: {
      content: {
        type: 'string',
        description: 'Der zu speichernde Inhalt (max 10000 Zeichen)',
      },
      type: {
        type: 'string',
        enum: [...MEMORY_TYPES],
        description: 'Art des Eintrags',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Tags für spätere Suche (1-10 Tags)',
      },
      summary: {
        type: 'string',
        description: 'Optionale Kurzzusammenfassung (max 200 Zeichen)',
      },
      project: {
        type: 'string',
        description: 'Optionaler Projekt-Name',
      },
    },
    required: ['content', 'type', 'tags'],
  },
};
