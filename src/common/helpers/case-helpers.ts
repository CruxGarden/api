/**
 * Convert a camelCase string to snake_case
 */
function toSnakeCase(str: string): string {
  return str.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/**
 * Convert a snake_case string to camelCase
 */
function toCamelCase(str: string): string {
  return str.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}

/**
 * Recursively convert all keys of an object using a key transformer
 */
function convertKeys(obj: unknown, keyFn: (key: string) => string): unknown {
  if (Array.isArray(obj)) {
    return obj.map((item) => convertKeys(item, keyFn));
  }
  if (obj !== null && typeof obj === 'object' && !(obj instanceof Date)) {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[keyFn(key)] = convertKeys(value, keyFn);
    }
    return result;
  }
  return obj;
}

/**
 * Converts an object's keys from camelCase to snake_case for database operations
 */
export function toTableFields<T>(obj: T): Record<string, unknown> {
  return convertKeys(
    { ...(obj as unknown as Record<string, unknown>) },
    toSnakeCase,
  ) as Record<string, unknown>;
}

/**
 * Converts an object's keys from snake_case to camelCase for entity mapping
 */
export function toEntityFields<T>(obj: T): Record<string, unknown> {
  return convertKeys(
    obj as unknown as Record<string, unknown>,
    toCamelCase,
  ) as Record<string, unknown>;
}
