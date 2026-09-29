import { cronError, normalizeSchedule } from './cron';

/** Static Function declarations shared by publication and execution. */
export function functionName(path: string): string | null {
  const name = /^functions\/([A-Za-z0-9._-]+)\.js$/.exec(path)?.[1];
  return name && name !== 'secrets' ? name : null;
}

export function scheduleOf(code: string): string | null {
  const match = /export\s+const\s+schedule\s*=\s*(['"`])([^'"`]+)\1/.exec(code);
  if (!match) return null;
  const expression = match[2].trim();
  return cronError(expression) ? null : normalizeSchedule(expression);
}
