/**
 * Which browser origins may call the API. Auth is Bearer-token based (no
 * cookies), so CORS here is about which pages may *read* responses:
 * - crux.garden itself and the per-crux publish subdomains;
 * - the desktop app, whose renderer runs on the custom `crux-app://` scheme
 *   (Chromium reports that origin as `crux-app://index.html`);
 * - one extra origin from CORS_ORIGIN, or every origin when it is `*` (dev).
 */
const UUID_PATTERN =
  '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const PUBLISH_SUBDOMAIN_RE = new RegExp(
  `^https://${UUID_PATTERN}\\.publish\\.crux\\.garden$`,
);
const DESKTOP_SCHEME_RE = /^crux-app:\/\/[a-z0-9.-]*$/i;

export function isAllowedOrigin(
  origin: string | undefined,
  configured: string | undefined = process.env.CORS_ORIGIN,
): boolean {
  // No Origin header: server-to-server, curl, native fetch.
  if (!origin) return true;
  if (configured === '*') return true;
  return (
    origin === 'https://crux.garden' ||
    (!!configured && origin === configured) ||
    PUBLISH_SUBDOMAIN_RE.test(origin) ||
    DESKTOP_SCHEME_RE.test(origin)
  );
}
