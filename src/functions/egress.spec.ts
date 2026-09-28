import * as dns from 'node:dns/promises';
import * as http from 'node:http';
import * as https from 'node:https';
import type { AddressInfo } from 'node:net';
import { fetchEgress } from './egress';

describe('Function egress boundary', () => {
  const env = { ...process.env };
  let server: http.Server;
  let port: number;
  let hits: string[];
  let lookup: jest.SpyInstance;
  const url = (path = '/') => `http://service.example.test:${port}${path}`;
  const hosts = ['service.example.test'];

  beforeAll(async () => {
    server = http.createServer(async (req, res) => {
      hits.push(req.url!);
      if (req.url === '/stall') return;
      if (req.url === '/large') {
        // Never finish: a client that buffers before checking cannot pass.
        res.write(Buffer.alloc(1_000_001));
        return;
      }
      if (req.url === '/redirect') {
        res.writeHead(302, { Location: 'http://169.254.169.254/private' });
        res.end();
        return;
      }
      if (req.url === '/compressed') {
        res.writeHead(200, { 'Content-Encoding': 'gzip' });
        res.end('compressed response');
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          host: req.headers.host,
          encoding: req.headers['accept-encoding'],
          body: Buffer.concat(chunks).toString(),
        }),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    port = (server.address() as AddressInfo).port;
  });
  beforeEach(() => {
    hits = [];
    process.env.NURSERY_MODE = 'true';
    lookup = jest
      .spyOn(dns, 'lookup')
      .mockResolvedValue([{ address: '127.0.0.1', family: 4 }] as never);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
    process.env = { ...env };
    server.closeAllConnections();
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('pins the DNS answer while preserving the service Host and the JSON request', async () => {
    const response = await fetchEgress(hosts, url('/echo'), {
      method: 'POST',
      body: { message: 'hello' },
      headers: {
        Host: 'internal.test',
        'Accept-Encoding': 'gzip',
        'Content-Length': '99999',
      },
    });
    expect(response.ok).toBe(true);
    expect(await response.json()).toEqual({
      host: `service.example.test:${port}`,
      encoding: 'identity',
      body: '{"message":"hello"}',
    });
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(hits).toEqual(['/echo']);
  });

  it('checks every DNS answer before opening a socket', async () => {
    process.env.NURSERY_MODE = 'false';
    lookup.mockResolvedValue([
      { address: '8.8.8.8', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]);
    await expect(fetchEgress(hosts, url())).rejects.toMatchObject({
      status: 403,
    });
    expect(hits).toEqual([]);
  });

  it.each([
    '127.0.0.1',
    '0x7f000001',
    '10.0.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '100.127.255.255',
    '0.0.0.0',
    '224.0.0.1',
    '192.0.2.1',
    '[::1]',
    '[::ffff:7f00:1]',
    '[::ffff:169.254.169.254]',
    '[fc00::1]',
    '[fe80::1]',
    '[2002:7f00:1::]',
    '[64:ff9b::7f00:1]',
  ])('refuses non-public literal %s even on the allowlist', async (host) => {
    process.env.NURSERY_MODE = 'false';
    const target = new URL(`http://${host}/`);
    await expect(
      fetchEgress([target.hostname], target.href),
    ).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining('not reachable'),
    });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('never enables local egress in production Nursery mode', async () => {
    process.env.NODE_ENV = 'production';
    await expect(fetchEgress(hosts, url())).rejects.toMatchObject({
      status: 403,
    });
  });

  it('uses the public DNS answer for the socket and the original name for TLS', async () => {
    process.env.NURSERY_MODE = 'false';
    lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
    const request = jest.spyOn(https, 'request').mockImplementation(() => {
      throw new Error('test transport stop');
    });
    await expect(
      fetchEgress(hosts, 'https://service.example.test/path'),
    ).rejects.toMatchObject({ status: 502 });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        hostname: '8.8.8.8',
        servername: 'service.example.test',
        agent: false,
        headers: expect.objectContaining({ host: 'service.example.test' }),
      }),
      expect.any(Function),
    );
    expect(request.mock.calls[0][0]).not.toHaveProperty('rejectUnauthorized');
  });

  it('does not follow redirects into another network', async () => {
    const response = await fetchEgress(hosts, url('/redirect'));
    expect(response.status).toBe(302);
    expect(response.headers.location).toBe('http://169.254.169.254/private');
    expect(hits).toEqual(['/redirect']);
  });

  it('cuts off an oversized body before the server finishes sending it', async () => {
    await expect(fetchEgress(hosts, url('/large'))).rejects.toMatchObject({
      status: 502,
      message: expect.stringContaining('over 1 MB'),
    });
  });

  it('refuses compressed responses instead of bypassing the byte bound', async () => {
    await expect(fetchEgress(hosts, url('/compressed'))).rejects.toMatchObject({
      status: 502,
      message: expect.stringContaining('compressed'),
    });
  });

  it('bounds a stalled network response', async () => {
    await expect(fetchEgress(hosts, url('/stall'))).rejects.toMatchObject({
      status: 502,
      message: 'fetch: timed out',
    });
  }, 10_000);

  it('times out DNS and never connects when its late answer arrives', async () => {
    jest.useFakeTimers();
    let resolveLookup: (addresses: unknown) => void;
    lookup.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveLookup = resolve;
        }),
    );
    const request = jest.spyOn(http, 'request');
    const pending = expect(fetchEgress(hosts, url())).rejects.toMatchObject({
      status: 502,
      message: 'fetch: timed out',
    });
    await jest.advanceTimersByTimeAsync(4001);
    await pending;
    resolveLookup!([{ address: '127.0.0.1', family: 4 }]);
    await jest.advanceTimersByTimeAsync(1);
    expect(request).not.toHaveBeenCalled();
  });

  it('bounds concurrent outbound work and recovers capacity after deadlines', async () => {
    jest.useFakeTimers();
    lookup.mockImplementation(() => new Promise(() => {}));
    const active = Promise.allSettled(
      Array.from({ length: 32 }, () => fetchEgress(hosts, url())),
    );
    await expect(fetchEgress(hosts, url())).rejects.toMatchObject({
      status: 503,
    });
    await jest.advanceTimersByTimeAsync(4001);
    expect((await active).every((result) => result.status === 'rejected')).toBe(
      true,
    );
    jest.useRealTimers();
    lookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    expect((await fetchEgress(hosts, url())).status).toBe(200);
  });

  it('rejects undeclared hosts, URL credentials and oversized requests before DNS', async () => {
    await expect(
      fetchEgress(['*.example.test'], 'http://example.test.attacker.test/'),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      fetchEgress(hosts, 'http://user:pass@service.example.test/'),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      fetchEgress(hosts, url(), {
        method: 'POST',
        body: 'x'.repeat(1_000_001),
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(lookup).not.toHaveBeenCalled();
  });
});
