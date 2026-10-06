import * as dns from 'node:dns/promises';
import * as http from 'node:http';
import * as https from 'node:https';
import { isIP } from 'node:net';
import * as ipaddr from 'ipaddr.js';

const MAX_BYTES = 1_000_000;
const TIMEOUT_MS = 4000;
const MAX_ACTIVE_REQUESTS = 32;
let activeRequests = 0;

class EgressError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(`fetch: ${message}`);
  }
}

/** Only ordinary public unicast addresses may leave a hosted Function. */
function publicAddress(address: string): boolean {
  if (!isIP(address)) return false;
  const parsed = ipaddr.process(address);
  if (parsed.range() !== 'unicast') return false;
  // Fail closed for unallocated IPv6 space and transition address families.
  return parsed.kind() === 'ipv4' || parsed.match(ipaddr.parse('2000::'), 3);
}

function allowedHost(hostname: string, hosts: string[]): boolean {
  return hosts.some((entry) => {
    const host = entry
      .trim()
      .toLowerCase()
      .replace(/^\[|\]$/g, '')
      .replace(/\.$/, '');
    if (host.startsWith('*.'))
      return hostname === host.slice(2) || hostname.endsWith(host.slice(1));
    return hostname === host;
  });
}

/** Resolve once, inspect every answer, then connect directly to the chosen address. */
async function destination(hostname: string, local: boolean) {
  const family = isIP(hostname);
  const addresses = family
    ? [{ address: hostname, family }]
    : await dns.lookup(hostname, { all: true, verbatim: true });
  if (
    !addresses.length ||
    (!local &&
      (hostname === 'localhost' ||
        hostname.endsWith('.localhost') ||
        addresses.some(({ address }) => !publicAddress(address))))
  ) {
    throw new EgressError(`${hostname} is not reachable`, 403);
  }
  return addresses[0];
}

export async function fetchEgress(
  hosts: string[],
  url: string,
  init?: Record<string, unknown>,
) {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new EgressError('invalid URL', 400);
  }
  if (
    !['http:', 'https:'].includes(target.protocol) ||
    target.username ||
    target.password
  )
    throw new EgressError('only http and https URLs without credentials', 400);
  const hostname = target.hostname
    .replace(/^\[|\]$/g, '')
    .toLowerCase()
    .replace(/\.$/, '');
  if (!allowedHost(hostname, hosts))
    throw new EgressError(
      `${hostname} is not in functions/egress.json ("hosts")`,
      403,
    );
  if (activeRequests >= MAX_ACTIVE_REQUESTS)
    throw new EgressError('outbound request capacity reached', 503);
  activeRequests++;
  const local =
    process.env.NURSERY_MODE === 'true' &&
    process.env.NODE_ENV !== 'production';
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new EgressError('timed out', 502));
    }, TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      requestEgress(target, hostname, local, init, controller.signal),
      deadline,
    ]);
  } catch (error) {
    if (error instanceof EgressError) throw error;
    throw new EgressError(
      controller.signal.aborted ? 'timed out' : 'outbound request failed',
      502,
    );
  } finally {
    clearTimeout(timer);
    activeRequests--;
  }
}

async function requestEgress(
  target: URL,
  hostname: string,
  local: boolean,
  init: Record<string, unknown> | undefined,
  signal: AbortSignal,
) {
  const method = String(init?.method ?? 'GET').toUpperCase();
  if (
    !['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(
      method,
    )
  )
    throw new EgressError('unsupported HTTP method', 400);
  const body =
    init?.body == null
      ? undefined
      : typeof init.body === 'string'
        ? init.body
        : JSON.stringify(init.body);
  if (
    body !== undefined &&
    (Buffer.byteLength(body) > MAX_BYTES ||
      method === 'GET' ||
      method === 'HEAD')
  )
    throw new EgressError('invalid or oversized request body', 400);
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(
    (init?.headers as Record<string, unknown>) ?? {},
  )) {
    const name = key.toLowerCase();
    if (
      [
        'host',
        'connection',
        'content-length',
        'transfer-encoding',
        'upgrade',
        'accept-encoding',
        'te',
        'trailer',
        'expect',
      ].includes(name) ||
      name.startsWith('proxy-')
    )
      continue;
    headers[name] = String(value);
  }
  headers.host = target.host;
  headers['accept-encoding'] = 'identity';
  if (body !== undefined && !headers['content-type'])
    headers['content-type'] = 'application/json';
  const address = await destination(hostname, local);
  // A late DNS answer after the deadline must never open a connection.
  signal.throwIfAborted();
  return new Promise<{
    ok: boolean;
    status: number;
    headers: Record<string, string>;
    text: () => Promise<string>;
    json: () => Promise<unknown>;
  }>((resolve, reject) => {
    const request = target.protocol === 'https:' ? https.request : http.request;
    const req = request(
      {
        protocol: target.protocol,
        hostname: address.address,
        family: address.family,
        port: target.port || undefined,
        path: target.pathname + target.search,
        method,
        headers,
        // TLS authenticates the original service name, not the pinned IP.
        servername: isIP(hostname) ? undefined : hostname,
        agent: false,
        signal,
        maxHeaderSize: 16_384,
      },
      (res) => {
        const encoding = res.headers['content-encoding'];
        if (encoding && encoding !== 'identity') {
          res.destroy(
            new EgressError('compressed responses are not supported', 502),
          );
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('error', reject);
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BYTES) {
            res.destroy(new EgressError('the answer is over 1 MB', 502));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          const text = Buffer.concat(chunks, size).toString('utf8');
          const status = res.statusCode ?? 502;
          const outHeaders = Object.fromEntries(
            Object.entries(res.headers)
              .filter(([, value]) => value !== undefined)
              .map(([key, value]) => [
                key,
                Array.isArray(value) ? value.join(', ') : value!,
              ]),
          );
          resolve({
            ok: status >= 200 && status < 300,
            status,
            headers: outHeaders,
            text: async () => text,
            json: async () => JSON.parse(text) as unknown,
          });
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}
