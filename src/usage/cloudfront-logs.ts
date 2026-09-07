import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

/**
 * CloudFront standard access logs. Two shapes, both gzipped or plain:
 * - legacy / v2 "plain": W3C extended, tab-separated, a #Fields header line;
 * - v2 "json": one JSON object per line, keys named like the W3C fields
 *   (`date`, `sc-bytes`, `x-host-header`; some emit `timestamp` instead of date).
 * We need the day, the viewer's Host, bytes to the client, the request count,
 * and — for the visitor count — who asked: the viewer's IP and User-Agent,
 * hashed with the day and a salt into an opaque token that only ever says
 * "same visitor, same day". No address is kept, nothing links days, and
 * known crawlers and failed requests are left out of the tally. Pure: bytes
 * in, totals per (host, day) out. Parquet is not read here.
 */
export interface HostDayTotals {
  host: string;
  day: string; // YYYY-MM-DD (UTC)
  bytes: number;
  requests: number;
  /** distinct visitor tokens seen in this file (see `visitorToken`) */
  visitors: string[];
}

export interface ParseOptions {
  /** mixed into every visitor token so tokens cannot be recomputed from an IP list */
  salt?: string;
}

const BOT_RE =
  /bot|crawl|spider|slurp|preview|monitor|fetch|scan|curl\/|wget\/|python-requests|headless|lighthouse|facebookexternalhit|pingdom|uptime/i;

/**
 * An opaque per-day identity for a viewer. Same IP + User-Agent on the same
 * day → same token; a different day → unrelated token. Bots and requests
 * without an address yield null and are not counted as anyone.
 */
export function visitorToken(
  day: string,
  ip: string | undefined,
  userAgent: string | undefined,
  status: string | undefined,
  salt = '',
): string | null {
  if (!ip || ip === '-') return null;
  if (status && Number(status) >= 400) return null;
  const ua = userAgent && userAgent !== '-' ? userAgent : '';
  if (BOT_RE.test(ua)) return null;
  return createHash('sha256')
    .update(`${salt}|${day}|${ip}|${ua}`)
    .digest('base64url')
    .slice(0, 22);
}

export function parseCloudFrontLog(
  raw: Buffer,
  opts: ParseOptions = {},
): HostDayTotals[] {
  const text = looksGzipped(raw)
    ? gunzipSync(raw).toString('utf8')
    : raw.toString('utf8');
  const lines = text.split('\n');
  let fields: string[] = [];
  const totals = new Map<string, HostDayTotals>();
  const seen = new Map<string, Set<string>>();
  const add = (
    day: string | undefined,
    host: string,
    bytes: number,
    visitor: string | null,
  ) => {
    if (!day || !host || host === '-') return;
    const key = `${host}|${day}`;
    const t = totals.get(key) ?? {
      host,
      day,
      bytes: 0,
      requests: 0,
      visitors: [],
    };
    t.bytes += Number.isFinite(bytes) ? bytes : 0;
    t.requests += 1;
    if (visitor) {
      const set = seen.get(key) ?? new Set<string>();
      if (!set.has(visitor)) {
        set.add(visitor);
        t.visitors.push(visitor);
      }
      seen.set(key, set);
    }
    totals.set(key, t);
  };
  for (const line of lines) {
    if (!line || !line.trim()) continue;
    if (line.trimStart().startsWith('{')) {
      const rec = parseJsonRecord(line);
      if (rec)
        add(
          rec.day,
          rec.host,
          rec.bytes,
          visitorToken(rec.day ?? '', rec.ip, rec.ua, rec.status, opts.salt),
        );
      continue;
    }
    if (line.startsWith('#Fields:')) {
      fields = line.slice('#Fields:'.length).trim().split(/\s+/);
      continue;
    }
    if (line.startsWith('#')) continue;
    if (!fields.length) continue;
    const cols = line.split('\t');
    const get = (name: string) => {
      const i = fields.indexOf(name);
      return i >= 0 ? cols[i] : undefined;
    };
    const day = get('date');
    // x-host-header is the Host the viewer sent (the crux subdomain or a custom domain);
    // cs(Host) is the distribution's domain — only a fallback.
    const host = (get('x-host-header') || get('cs(Host)') || '').toLowerCase();
    const bytes = Number(get('sc-bytes') || 0);
    add(
      day,
      host,
      bytes,
      visitorToken(
        day ?? '',
        get('c-ip'),
        get('cs(User-Agent)'),
        get('sc-status'),
        opts.salt,
      ),
    );
  }
  return [...totals.values()];
}

function parseJsonRecord(line: string): {
  day: string | undefined;
  host: string;
  bytes: number;
  ip?: string;
  ua?: string;
  status?: string;
} | null {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  const str = (k: string) => {
    const v = o[k];
    return v === undefined || v === null ? undefined : String(v);
  };
  let day = str('date');
  if (!day) {
    // v2 may emit `timestamp` (seconds, ms, or ISO) or `timestamp(ms)`
    const ts = str('timestamp') ?? str('timestamp(ms)');
    if (ts) {
      const num = Number(ts);
      const d = Number.isFinite(num)
        ? new Date(num > 1e12 ? num : num * 1000)
        : new Date(ts);
      if (!Number.isNaN(d.getTime())) day = d.toISOString().slice(0, 10);
    }
  }
  const host = (str('x-host-header') || str('cs(Host)') || '').toLowerCase();
  return {
    day,
    host,
    bytes: Number(str('sc-bytes') || 0),
    ip: str('c-ip'),
    ua: str('cs(User-Agent)') ?? str('cs-user-agent'),
    status: str('sc-status'),
  };
}

function looksGzipped(b: Buffer): boolean {
  return b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `{cruxId}.publish.crux.garden` → cruxId; anything else → null (a custom domain, looked up elsewhere). */
export function cruxIdFromPublishHost(host: string): string | null {
  const label = host.split('.')[0] ?? '';
  return UUID_RE.test(label) ? label : null;
}
