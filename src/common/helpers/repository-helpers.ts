import { RepositoryResponse } from '../types/interfaces';

/**
 * Converts undefined to null for repository responses
 */
export function toNullable<T>(value: T | undefined): T | null {
  return value ?? null;
}

/**
 * Converts unknown error to Error instance
 */
export function toError(error: unknown): Error {
  if (error instanceof Error) return error;
  // Native drivers can return errors constructed in another JS realm. Keep
  // their machine-readable code so a constraint collision remains a conflict.
  if (error && typeof error === 'object' && 'message' in error) {
    const normalized = new Error(String(error.message));
    if ('code' in error && typeof error.code === 'string') {
      Object.assign(normalized, { code: error.code });
    }
    return normalized;
  }
  return new Error(String(error));
}

/**
 * Creates a successful repository response
 */
export function success<T>(data: T | undefined): RepositoryResponse<T> {
  return { data: toNullable(data), error: null };
}

/**
 * Creates a failed repository response
 */
export function failure<T>(error: unknown): RepositoryResponse<T> {
  return { data: null, error: toError(error) };
}
