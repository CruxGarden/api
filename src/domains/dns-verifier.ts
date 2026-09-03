import { promises as dns } from 'node:dns';

/** Resolves the two records a custom domain needs; injectable so tests don't hit DNS. */
export interface DnsVerifier {
  cnameTargets(hostname: string): Promise<string[]>;
  txtValues(hostname: string): Promise<string[]>;
}

export const nodeDnsVerifier: DnsVerifier = {
  async cnameTargets(hostname) {
    try {
      return (await dns.resolveCname(hostname)).map(norm);
    } catch {
      return [];
    }
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
