// Structured error factory — single shape for every failure path.
import type { ErrorCode, StructuredError } from '../types/index.js';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }

  toStructured(): StructuredError {
    return {
      code: this.code,
      message: this.message,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export function toStructuredError(error: unknown): StructuredError {
  if (error instanceof AppError) {
    return error.toStructured();
  }
  if (error instanceof Error) {
    if (error.name === 'AbortError') {
      return { code: 'TIMEOUT', message: 'Request timed out' };
    }
    return { code: 'INTERNAL_ERROR', message: error.message };
  }
  return { code: 'INTERNAL_ERROR', message: 'Unknown error' };
}

export function fail(code: ErrorCode, message: string, details?: Record<string, unknown>): never {
  throw new AppError(code, message, details);
}
