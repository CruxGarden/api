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

/**
 * The static allow-list plus one dynamic case: an origin whose hostname is an
 * active Custom Domain (a Banner over a published crux). Pages served under a
 * Banner call the API for the Crux Store and sign-in exactly as the publish
 * subdomain does, so their origin has to pass too. `lookup` answers whether a
 * hostname is a live custom domain; results are cached briefly so CORS
 * preflights never turn into a database query per request.
 */
export function makeOriginCheck(
  lookup: (hostname: string) => Promise<boolean>,
  opts: { ttlMs?: number; now?: () => number } = {},
): (origin: string | undefined) => Promise<boolean> {
  const ttl = opts.ttlMs ?? 60_000;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, { ok: boolean; until: number }>();
  return async (origin) => {
    if (isAllowedOrigin(origin)) return true;
    if (!origin) return false;
    let hostname: string;
    try {
      const u = new URL(origin);
      if (u.protocol !== 'https:') return false;
      hostname = u.hostname.toLowerCase();
    } catch {
      return false;
    }
    const hit = cache.get(hostname);
    if (hit && hit.until > now()) return hit.ok;
    let ok = false;
    try {
      ok = await lookup(hostname);
    } catch {
      ok = false; // a lookup failure is a refusal, never an allow
    }
    cache.set(hostname, { ok, until: now() + ttl });
    return ok;
  };
}
