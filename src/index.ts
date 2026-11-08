#!/usr/bin/env node
/**
 * Master Brain MCP Hub
 *
 * MCP server that connects AI coding tools to the Master Brain backend.
 * Auto-Memory is explicit: callers must invoke `brain_observe` (or processInteraction)
 * because stdio MCP cannot passively observe the full conversation stream.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { config } from 'dotenv';
import { z } from 'zod';

import {
  brainSearch,
  searchSchema,
  searchToolDefinition,
  brainSave,
  saveSchema,
  saveToolDefinition,
  brainStats,
  statsToolDefinition,
  brainRecent,
  recentSchema,
  recentToolDefinition,
  brainObserve,
  observeSchema,
  observeToolDefinition,
} from './tools/index.js';
import { getAutoMemory } from './middleware/auto-memory.js';
import { getBrainClient } from './brain/client.js';
import { AppError, toStructuredError } from './lib/errors.js';
import type { MCPToolResult } from './types/index.js';

config();

const VERSION = '1.1.0';

const autoMemoryConfigSchema = z.object({
  enabled: z.boolean().optional(),
  minConfidence: z.number().min(0).max(1).optional(),
  maxEntriesPerSession: z.number().int().min(1).max(10_000).optional(),
});

const server = new Server(
  {
    name: 'master-brain-mcp',
    version: VERSION,
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

const tools = [
  searchToolDefinition,
  saveToolDefinition,
  statsToolDefinition,
  recentToolDefinition,
  observeToolDefinition,
  {
    name: 'brain_health',
    description: 'Prüft ob das Master Brain erreichbar ist',
    inputSchema: { type: 'object', properties: {}, required: [] as string[] },
  },
  {
    name: 'auto_memory_status',
    description: 'Zeigt Status der Auto-Memory Middleware',
    inputSchema: { type: 'object', properties: {}, required: [] as string[] },
  },
  {
    name: 'auto_memory_config',
    description: 'Konfiguriert die Auto-Memory Middleware (runtime, non-persistent)',
    inputSchema: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean', description: 'Auto-Memory aktivieren/deaktivieren' },
        minConfidence: {
          type: 'number',
          description: 'Min. Confidence zum Speichern (0-1)',
        },
        maxEntriesPerSession: {
          type: 'number',
          description: 'Max. Auto-Saves pro Session',
        },
      },
    },
  },
];

function toolResult(result: MCPToolResult) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    isError: !result.success,
  };
}

function validationError(issues: z.ZodIssue[]) {
  return toolResult({
    success: false,
    error: {
      code: 'VALIDATION_ERROR',
      message: 'Invalid tool arguments',
      details: {
        issues: issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    },
  });
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: rawArgs } = request.params;
  const args = (rawArgs ?? {}) as Record<string, unknown>;

  try {
    switch (name) {
      case 'brain_search': {
        const parsed = searchSchema.safeParse(args);
        if (!parsed.success) return validationError(parsed.error.issues);
        return toolResult(await brainSearch(parsed.data));
      }

      case 'brain_save': {
        const parsed = saveSchema.safeParse(args);
        if (!parsed.success) return validationError(parsed.error.issues);
        return toolResult(await brainSave(parsed.data));
      }

      case 'brain_stats': {
        return toolResult(await brainStats());
      }

      case 'brain_recent': {
        const parsed = recentSchema.safeParse(args);
        if (!parsed.success) return validationError(parsed.error.issues);
        return toolResult(await brainRecent(parsed.data));
      }

      case 'brain_observe': {
        const parsed = observeSchema.safeParse(args);
        if (!parsed.success) return validationError(parsed.error.issues);
        return toolResult(await brainObserve(parsed.data));
      }

      case 'brain_health': {
        const brain = getBrainClient();
        const health = await brain.health();
        return toolResult({
          success: true,
          data: {
            brainConnected: health.ok,
            version: health.version,
            mcpVersion: VERSION,
          },
        });
      }

      case 'auto_memory_status': {
        const autoMemory = getAutoMemory();
        return toolResult({ success: true, data: autoMemory.getStatus() });
      }

      case 'auto_memory_config': {
        const parsed = autoMemoryConfigSchema.safeParse(args);
        if (!parsed.success) return validationError(parsed.error.issues);
        const autoMemory = getAutoMemory();
        autoMemory.updateConfig(parsed.data);
        return toolResult({
          success: true,
          data: {
            message: 'Konfiguration aktualisiert (runtime only)',
            config: autoMemory.getStatus().config,
          },
        });
      }

      default:
        return toolResult({
          success: false,
          error: {
            code: 'UNKNOWN_TOOL',
            message: `Unknown tool: ${name}`,
          },
        });
    }
  } catch (error) {
    if (error instanceof AppError) {
      return toolResult({ success: false, error: error.toStructured() });
    }
    return toolResult({ success: false, error: toStructuredError(error) });
  }
});

async function main() {
  console.error(`[Master Brain MCP Hub v${VERSION}] Starting...`);

  const brain = getBrainClient();
  const health = await brain.health();
  if (health.ok) {
    console.error(`[Master Brain MCP Hub] Connected to Brain (v${health.version})`);
  } else {
    console.error(
      '[Master Brain MCP Hub] WARNING: Brain not reachable at BRAIN_API_URL — tools will fail until it is up'
    );
  }

  const autoMemory = getAutoMemory();
  const status = autoMemory.getStatus();
  console.error(
    `[Master Brain MCP Hub] Auto-Memory: ${status.config.enabled ? 'enabled' : 'disabled'} (model=${status.config.analysisModel})`
  );
  console.error(
    '[Master Brain MCP Hub] NOTE: Auto-Memory is explicit — use tool brain_observe from hooks/agents'
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('[Master Brain MCP Hub] Ready!');
}

main().catch((error) => {
  console.error('[Master Brain MCP Hub] Fatal error:', error);
  process.exit(1);
});
