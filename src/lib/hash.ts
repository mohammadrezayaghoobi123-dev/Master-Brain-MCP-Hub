// Content hashing for deduplication — cryptographic, not rolling integer.
import { createHash } from 'node:crypto';

/**
 * SHA-256 hex digest of normalized content.
 * Normalization collapses whitespace so trivial formatting changes do not
 * bypass deduplication.
 */
export function contentHash(content: string): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}
