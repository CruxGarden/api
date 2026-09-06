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
 * Convert the keys of ONE object — the row's column names — leaving every
 * value alone. Values are column contents: JSON columns (`meta`, `data`) hold
 * what the app wrote, in its own casing, and must round-trip byte for byte.
 * (Until 2026-09-06 this recursed, so `meta.publishedAt` was stored as
 * `published_at`; readers that query the row directly never saw it.)
 */
function convertKeys(obj: unknown, keyFn: (key: string) => string): unknown {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    result[keyFn(key)] = value;
  }
  return result;
}

/**
 * Recursively convert keys at every depth — what the write path used to do to
 * JSON columns. Kept for the one-off data migration that undoes it.
 */
export function deepConvertKeys(
  obj: unknown,
  keyFn: (key: string) => string,
): unknown {
  if (Array.isArray(obj))
    return obj.map((item) => deepConvertKeys(item, keyFn));
  if (obj !== null && typeof obj === 'object' && !(obj instanceof Date)) {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[keyFn(key)] = deepConvertKeys(value, keyFn);
    }
    return result;
  }
  return obj;
}

export const camelCaseKey = toCamelCase;
export const snakeCaseKey = toSnakeCase;

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
