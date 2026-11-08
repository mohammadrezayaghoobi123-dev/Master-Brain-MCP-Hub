// Master Brain MCP Hub - Type Definitions
// All domain types live here. Contracts must stay aligned with CONTRACTS/*.

/** Canonical memory type set. Keep in sync with Zod enums in tools and data_contract. */
export const MEMORY_TYPES = [
  'decision',
  'fix',
  'learning',
  'pattern',
  'preference',
  'config',
  'error',
  'context',
  'conversation',
] as const;

export type MemoryType = (typeof MEMORY_TYPES)[number];

export interface BrainEntry {
  id: string;
  type: MemoryType;
  content: string;
  summary?: string;
  tags: string[];
  source: MemorySource;
  /** ISO-8601 string from API; never assume Date at the boundary. */
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface MemorySource {
  tool: 'claude-code' | 'codex' | 'cursor' | 'api' | 'manual' | 'auto-memory';
  session_id?: string;
  project?: string;
  file?: string;
  user_id?: string;
}

export interface AnalysisResult {
  isImportant: boolean;
  type: MemoryType;
  summary: string;
  tags: string[];
  confidence: number;
  context?: string;
}

export interface SearchResult {
  entries: BrainEntry[];
  total: number;
  query: string;
  mode: 'semantic' | 'keyword' | 'hybrid';
}

export interface BrainStats {
  totalEntries: number;
  entriesByType: Partial<Record<MemoryType, number>>;
  entriesBySource: Record<string, number>;
  lastUpdated: string;
  storageSize: string;
}

export interface AutoMemoryConfig {
  enabled: boolean;
  minConfidence: number;
  excludeTypes: MemoryType[];
  maxEntriesPerSession: number;
  /** Minutes retained for content-hash deduplication (persistent store). */
  deduplicationWindowMinutes: number;
  /** Anthropic model id used for importance analysis. */
  analysisModel: string;
}

export interface MCPToolResult {
  success: boolean;
  data?: unknown;
  error?: StructuredError;
}

/** Stable, machine-readable error surface for all tool responses. */
export interface StructuredError {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'BRAIN_UNREACHABLE'
  | 'BRAIN_HTTP_ERROR'
  | 'TIMEOUT'
  | 'RATE_LIMITED'
  | 'ANALYSIS_FAILED'
  | 'INTERNAL_ERROR'
  | 'UNKNOWN_TOOL'
  | 'DISABLED';
