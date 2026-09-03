import { gunzipSync } from 'node:zlib';

/**
 * CloudFront standard access logs (W3C extended format, gzipped, tab-separated):
 * two header lines (#Version, #Fields) then one request per line. We only
 * need the day, the viewer's Host, bytes to the client and the request count.
 * Pure: bytes in, totals per (host, day) out.
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
  for (const line of lines) {
    if (!line) continue;
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
    if (!day || !host || host === '-') continue;
    const key = `${host}|${day}`;
    const t = totals.get(key) ?? { host, day, bytes: 0, requests: 0 };
    t.bytes += Number.isFinite(bytes) ? bytes : 0;
    t.requests += 1;
    totals.set(key, t);
  }
  return [...totals.values()];
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
