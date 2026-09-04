import { gunzipSync } from 'node:zlib';

/**
 * CloudFront standard access logs. Two shapes, both gzipped or plain:
 * - legacy / v2 "plain": W3C extended, tab-separated, a #Fields header line;
 * - v2 "json": one JSON object per line, keys named like the W3C fields
 *   (`date`, `sc-bytes`, `x-host-header`; some emit `timestamp` instead of date).
 * We only need the day, the viewer's Host, bytes to the client and the request
 * count. Pure: bytes in, totals per (host, day) out. Parquet is not read here.
 */
export interface HostDayTotals {
  host: string;
  day: string; // YYYY-MM-DD (UTC)
  bytes: number;
  requests: number;
}

export function parseCloudFrontLog(raw: Buffer): HostDayTotals[] {
  const text = looksGzipped(raw)
    ? gunzipSync(raw).toString('utf8')
    : raw.toString('utf8');
  const lines = text.split('\n');
  let fields: string[] = [];
  const totals = new Map<string, HostDayTotals>();
  const add = (day: string | undefined, host: string, bytes: number) => {
    if (!day || !host || host === '-') return;
    const key = `${host}|${day}`;
    const t = totals.get(key) ?? { host, day, bytes: 0, requests: 0 };
    t.bytes += Number.isFinite(bytes) ? bytes : 0;
    t.requests += 1;
    totals.set(key, t);
  };
  for (const line of lines) {
    if (!line || !line.trim()) continue;
    if (line.trimStart().startsWith('{')) {
      const rec = parseJsonRecord(line);
      if (rec) add(rec.day, rec.host, rec.bytes);
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
    add(day, host, bytes);
  }
  return [...totals.values()];
}

function parseJsonRecord(
  line: string,
): { day: string | undefined; host: string; bytes: number } | null {
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
  return { day, host, bytes: Number(str('sc-bytes') || 0) };
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
