import { promises as dns } from 'node:dns';

/** Resolves the two records a custom domain needs; injectable so tests don't hit DNS. */
export interface DnsVerifier {
  cnameTargets(hostname: string): Promise<string[]>;
  txtValues(hostname: string): Promise<string[]>;
  /** A and AAAA records — what an ALIAS/ANAME or a flattened CNAME resolves to. */
  addresses(hostname: string): Promise<string[]>;
}

export const nodeDnsVerifier: DnsVerifier = {
  async cnameTargets(hostname) {
    try {
      return (await dns.resolveCname(hostname)).map(norm);
    } catch {
      return [];
    }
  },
  async addresses(hostname) {
    const [a, aaaa] = await Promise.all([
      dns.resolve4(hostname).catch(() => [] as string[]),
      dns.resolve6(hostname).catch(() => [] as string[]),
    ]);
    return [...a, ...aaaa].map((ip) => ip.toLowerCase());
  },
  async txtValues(hostname) {
    try {
      return (await dns.resolveTxt(hostname)).map((chunks) => chunks.join(''));
    } catch {
      return [];
    }
  },
};

export function norm(host: string): string {
  return host.toLowerCase().replace(/\.$/, '');
}

const HOSTNAME_RE =
  /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

/** Lower-cased, trailing dot removed; null when it isn't a usable hostname. */
export function normalizeHostname(input: string): string | null {
  const h = norm(input.trim());
  if (!HOSTNAME_RE.test(h)) return null;
  if (h.endsWith('.crux.garden')) return null; // ours
  return h;
}

export function verificationRecordName(hostname: string): string {
  return `_crux-verify.${hostname}`;
}

/** Registry suffixes under which a two-label name is still a registrable apex (co.uk, com.au…). */
const TWO_PART_SUFFIXES = new Set([
  'co.uk',
  'org.uk',
  'me.uk',
  'ac.uk',
  'gov.uk',
  'co.nz',
  'org.nz',
  'net.nz',
  'com.au',
  'net.au',
  'org.au',
  'co.za',
  'com.br',
  'com.mx',
  'co.jp',
  'or.jp',
  'ne.jp',
  'co.kr',
  'com.tr',
  'com.sg',
  'com.hk',
  'co.in',
  'co.il',
  'com.ar',
  'com.cn',
  'com.tw',
  'com.my',
  'co.th',
  'com.ph',
  'com.pk',
]);

/**
 * Whether a hostname is a bare (apex) domain — `zacos.tech`, `example.co.uk` —
 * as opposed to a subdomain. An apex cannot carry a CNAME, so the record we
 * ask for is an ALIAS/ANAME (or flattened CNAME) to the gate instead.
 */
export function isApexDomain(hostname: string): boolean {
  const labels = norm(hostname).split('.');
  if (labels.length === 2) return true;
  if (labels.length === 3 && TWO_PART_SUFFIXES.has(labels.slice(1).join('.')))
    return true;
  return false;
}

/**
 * Does `hostname` point at `target`? A CNAME to the target is the plain case.
 * An apex (or a provider that flattens) shows no CNAME, only addresses — then
 * it points at the target when it shares an address with it, both looked up
 * from the same resolver at the same moment.
 */
export async function pointsAt(
  dns: DnsVerifier,
  hostname: string,
  target: string,
): Promise<boolean> {
  const cnames = await dns.cnameTargets(hostname);
  if (cnames.map(norm).includes(norm(target))) return true;
  const [mine, theirs] = await Promise.all([
    dns.addresses(hostname),
    dns.addresses(target),
  ]);
  return mine.length > 0 && mine.some((ip) => theirs.includes(ip));
}
