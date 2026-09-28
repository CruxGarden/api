import type { Response } from 'express';
import type { RunResult } from './functions.service';

const CONTENT_TYPES = new Set(['text/plain', 'text/html', 'application/json']);

/** Handlers control their answer, never the security policy of the API origin. */
export function sendFunctionResponse(
  res: Response,
  result: RunResult,
  isOwner: boolean,
): void {
  res.setHeader(
    'Content-Security-Policy',
    "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Crux-Function-Ms', String(result.ms));
  if (isOwner && result.logs.length)
    res.setHeader(
      'X-Crux-Function-Logs',
      encodeURIComponent(result.logs.join('\n')),
    );

  if (
    !Number.isInteger(result.status) ||
    result.status < 200 ||
    result.status > 599
  ) {
    res.status(500).json({ error: 'Invalid function response status' });
    return;
  }
  res.status(result.status);
  // Location is the only handler header in the public ctx contract (ctx.redirect).
  for (const [key, value] of Object.entries(result.headers ?? {})) {
    if (key.toLowerCase() === 'location' && safeLocation(value))
      res.setHeader('Location', value);
  }
  if (result.contentType) {
    const type = result.contentType.split(';', 1)[0].trim().toLowerCase();
    res.setHeader(
      'Content-Type',
      `${CONTENT_TYPES.has(type) ? type : 'text/plain'}; charset=utf-8`,
    );
    res.send(String(result.body ?? ''));
  } else {
    // Nest sends returned strings as text; ordinary function values are always JSON.
    res.json(result.body);
  }
}

function safeLocation(value: unknown): value is string {
  if (typeof value !== 'string' || /[\u0000-\u0020\u007f]/.test(value))
    return false;
  try {
    const url = new URL(value, 'https://relative.invalid');
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}
