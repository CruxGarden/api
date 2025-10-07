import { PathPrefix } from '../types/enums';

/**
 * Strips a path prefix from an identifier if present
 * @param identifier The identifier that may have a prefix
 * @param prefix The prefix to strip
 * @returns Object with hasPrefix boolean and value (with prefix removed if present)
 */
export function stripPathPrefix(
  identifier: string,
  prefix: PathPrefix,
): { hasPrefix: boolean; value: string } {
  if (identifier.startsWith(prefix)) {
    return {
      hasPrefix: true,
      value: identifier.substring(prefix.length),
    };
  }
  return {
    hasPrefix: false,
    value: identifier,
  };
}
