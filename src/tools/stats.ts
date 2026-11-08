// MCP Tool: brain_stats
import { getBrainClient } from '../brain/client.js';
import type { MCPToolResult } from '../types/index.js';
import { toStructuredError } from '../lib/errors.js';

export async function brainStats(): Promise<MCPToolResult> {
  try {
    const brain = getBrainClient();
    const stats = await brain.stats();

    return {
      success: true,
      data: {
        totalEntries: stats.totalEntries,
        entriesByType: stats.entriesByType,
        entriesBySource: stats.entriesBySource,
        lastUpdated: stats.lastUpdated,
        storageSize: stats.storageSize,
      },
    };
  } catch (error) {
    return { success: false, error: toStructuredError(error) };
  }
}

export const statsToolDefinition = {
  name: 'brain_stats',
  description:
    'Zeigt Statistiken über das Master Brain: Anzahl Einträge, Verteilung nach Typ und Quelle, Speichergröße.',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [] as string[],
  },
};
