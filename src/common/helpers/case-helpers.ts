import camelcaseKeys from 'camelcase-keys';
import snakecaseKeys from 'snakecase-keys';

/**
 * Converts an object's keys from camelCase to snake_case for database operations
 */
export function toTableFields<T>(obj: T): Record<string, unknown> {
  return snakecaseKeys(obj as unknown as Record<string, unknown>);
}

/**
 * Converts an object's keys from snake_case to camelCase for entity mapping
 */
export function toEntityFields<T>(obj: T): Record<string, unknown> {
  return camelcaseKeys(obj as unknown as Record<string, unknown>);
}
