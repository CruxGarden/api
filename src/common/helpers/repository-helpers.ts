import { RepositoryResponse } from '../types/interfaces';

/**
 * Converts undefined to null for repository responses
 */
export function toNullable<T>(value: T | undefined): T | null {
  return value || null;
}

/**
 * Converts unknown error to Error instance
 */
export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
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
