import { FunctionsService, matches } from './functions.service';
import { ServiceUnavailableException } from '@nestjs/common';
import * as dns from 'node:dns/promises';
import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';

/**
 * The runner, with the crux, its published files and its Store faked:
 * a handler runs in a bare context against `ctx`, an event reaches the
 * handlers whose name or `match` fits, a bad handler answers 400, a
 * runaway one is cut off, and a page's stream hears the event.
 */
function service(
  files: Record<string, string>,
  store = new Map<string, unknown>(),
  publication: Record<string, unknown> = {},
) {
  const logger = {
    createChildLogger: () => ({
      warn: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
      error: jest.fn(),
    }),
  };
  const crux = {
    id: 'crux-1',
    authorId: 'author-1',
    meta: {
      publishedAt: '2026-09-20T00:00:00Z',
      publishedVersion: 3,
      ...publication,
    },
  };
  const artifacts = Object.keys(files).map((path, i) => ({
    id: `a${i}`,
    filename: path.split('/').pop(),
    meta: { path },
  }));
  const fileStore = {
    download: async ({
      path,
      namespace,
    }: {
      path: string;
      namespace?: string;
    }) => {
      const storageId = publication.publishStorageId || 'crux-1';
      if (publication.publishLayout === 'bucket-per-crux') {
        if (namespace !== `crux-${storageId}`)
          throw new Error('Wrong publication bucket');
      } else if (!path.startsWith(`${storageId}/`))
        throw new Error('Wrong publication prefix');
      const key =
        publication.publishLayout === 'bucket-per-crux'
          ? path
          : path.slice(String(storageId).length + 1);
      if (!(key in files)) throw new Error('missing');
      return { data: Buffer.from(files[key]) };
    },
  };
  const publishStorage = { bucketName: (id: string) => `crux-${id}` };
  const cruxService = {
    findById: async () => crux,
    getPublishedArtifacts: async () => artifacts,
    publishedRevision: async () => ({
      crux: structuredClone(await cruxService.findById()),
      artifacts: structuredClone(artifacts),
    }),
  };
  const kv = {
    get: async (_c: string, key: string) =>
      store.has(key) ? { value: store.get(key) } : null,
    serverSet: async (
      _c: string,
      _a: string,
      key: string,
      value: unknown,
      mode: string,
    ) => {
      store.set(key, value);
      return { value, mode };
    },
    list: async () =>
      [...store.entries()].map(([key, value]) => ({
        key,
        value,
        mode: 'public',
      })),
    delete: async (_c: string, key: string) => {
      store.delete(key);
    },
    increment: async (_c: string, _a: string, key: string, by: number) => {
      const next = (Number(store.get(key)) || 0) + by;
      store.set(key, next);
      return next;
    },
  };
  const usage = { noteFunctionRun: jest.fn() };
  // The schedules table, in memory: what load() declares, what runDue() claims.
  const table = new Map<
    string,
    { name: string; schedule: string; nextRun: Date; status?: string }
  >();
  const vault = new Map<
    string,
    { ciphertext: string; iv: string; tag: string }
  >();
  const schedules = {
    table,
    vault,
    putSecret: jest.fn(async (_c: string, name: string, enc: any) => {
      vault.set(name, enc);
      return { data: undefined };
    }),
    deleteSecret: jest.fn(async (_c: string, name: string) => {
      vault.delete(name);
      return { data: undefined };
    }),
    secretsFor: jest.fn(async (cruxId: string) => ({
      data: [...vault.entries()].map(([name, enc]) => ({
        crux_id: cruxId,
        name,
        ...enc,
        updated: new Date(),
      })),
    })),
    deleteSchedules: jest.fn(async () => ({ data: undefined })),
    listSchedules: jest.fn(async (cruxId: string) => ({
      data: [...table.entries()]
        .filter(([k]) => k.startsWith(`${cruxId}|`))
        .map(([, v]) => ({
          crux_id: cruxId,
          name: v.name,
          schedule: v.schedule,
          next_run: v.nextRun,
          last_run: null,
          last_status: v.status ?? null,
        })),
    })),
    claimDue: jest.fn(async (now: Date, next: (row: any) => Date | null) => {
      const due: any[] = [];
      for (const [k, v] of table) {
        if (v.nextRun.getTime() > now.getTime()) continue;
        const row = {
          crux_id: k.split('|')[0],
          name: v.name,
          schedule: v.schedule,
          next_run: v.nextRun,
          last_run: null,
          last_status: null,
        };
        const n = next(row);
        if (n) v.nextRun = n;
        else table.delete(k);
        due.push(row);
      }
      return { data: due };
    }),
    setStatus: jest.fn(async (cruxId: string, name: string, status: string) => {
      const v = table.get(`${cruxId}|${name}`);
      if (v) v.status = status;
      return { data: undefined };
    }),
  };
  const svc = new FunctionsService(
    logger as any,
    fileStore as any,
    publishStorage as any,
    cruxService as any,
    kv as any,
    usage as any,
    schedules as any,
  );
  return Object.assign(svc, {
    metered: usage,
    clock: schedules,
    kvStore: store,
    publishedFiles: fileStore,
    cruxLookup: cruxService,
  });
}

describe('Crux Functions runner', () => {
  it('refuses failed secret deletion, preserves the secret and permits retry', async () => {
    const svc = service({});
    svc.clock.vault.set('TOKEN', {
      ciphertext: 'retained',
      iv: 'iv',
      tag: 'tag',
    });
    svc.clock.deleteSecret.mockResolvedValueOnce({
      error: new Error('write refused'),
    } as never);
    await expect(svc.deleteSecret('crux-1', 'TOKEN')).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect(await svc.listSecretNames('crux-1')).toEqual([
      expect.objectContaining({ name: 'TOKEN' }),
    ]);
    await expect(svc.deleteSecret('crux-1', 'TOKEN')).resolves.toBeUndefined();
    expect(await svc.listSecretNames('crux-1')).toEqual([]);
  });

  it('reports secret and schedule read outages instead of an empty listing', async () => {
    const svc = service({ 'functions/tick.js': 'export default () => true;' });
    svc.clock.secretsFor.mockResolvedValueOnce({
      error: new Error('read refused'),
    } as never);
    await expect(svc.listSecretNames('crux-1')).rejects.toThrow(
      ServiceUnavailableException,
    );
    svc.clock.listSchedules.mockResolvedValueOnce({
      error: new Error('read refused'),
    } as never);
    await expect(svc.listWithSchedules('crux-1')).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect(await svc.listWithSchedules('crux-1')).toEqual([
      { name: 'tick', path: 'functions/tick.js', kind: 'http' },
    ]);
  });

  it('refuses execution during a secret outage before the handler can mutate the Store', async () => {
    const svc = service({
      'functions/use-token.js':
        'export default async (req, ctx) => { await ctx.store.set("ran", true); return ctx.secrets.get("TOKEN"); };',
    });
    svc.clock.secretsFor.mockResolvedValueOnce({
      error: new Error('read refused'),
    } as never);
    await expect(
      svc.call('crux-1', 'use-token', { body: null, visitorId: null }),
    ).rejects.toThrow(ServiceUnavailableException);
    expect(svc.kvStore.has('ran')).toBe(false);
    expect(
      await svc.call('crux-1', 'use-token', { body: null, visitorId: null }),
    ).toMatchObject({ status: 200 });
    expect(svc.kvStore.get('ran')).toBe(true);
  });

  it.each(['shared', 'bucket-per-crux'])(
    'executes functions from the committed %s storage location',
    async (layout) => {
      const svc = service(
        {
          'functions/version.js':
            'export default () => ({version: "committed"});',
        },
        new Map(),
        { publishLayout: layout, publishStorageId: 'publication-2' },
      );
      expect(
        (await svc.call('crux-1', 'version', { body: null, visitorId: null }))
          .body,
      ).toEqual({ version: 'committed' });
    },
  );
  it('lists the functions folder and tells HTTP handlers from event handlers', async () => {
    const s = service({
      'functions/hello.js':
        'export default async function () { return { ok: true } }',
      'functions/on-score.js': 'export default function () {}',
      'index.html': '<html></html>',
      'functions/notes.txt': 'not a function',
    });
    expect(await s.list('crux-1')).toEqual([
      { name: 'hello', path: 'functions/hello.js', kind: 'http' },
      {
        name: 'on-score',
        path: 'functions/on-score.js',
        kind: 'event',
        event: 'score',
      },
    ]);
  });

  it('runs a handler against the Store as the visitor, with ctx.json and ctx.log', async () => {
    const store = new Map<string, unknown>([['board/top', [1, 2]]]);
    const s = service(
      {
        'functions/submit.js': `
          export default async function (req, ctx) {
            const { points } = await req.json();
            if (typeof points !== 'number' || points > 1000) return ctx.reject('nice try');
            await ctx.store.set('score/' + ctx.visitor.id, { points, at: ctx.now() });
            ctx.log('scored', points);
            const top = await ctx.store.get('board/top');
            return ctx.json({ ok: true, top, who: ctx.visitor.id });
          }`,
      },
      store,
    );
    const r = await s.call('crux-1', 'submit', {
      body: { points: 7 },
      visitorId: 'v-1',
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, top: [1, 2], who: 'v-1' });
    expect(r.logs).toEqual(['scored 7']);
    expect((store.get('score/v-1') as { points: number }).points).toBe(7);
    const bad = await s.call('crux-1', 'submit', {
      body: { points: 9999 },
      visitorId: 'v-1',
    });
    expect(bad).toMatchObject({ status: 400, body: { error: 'nice try' } });
  });

  it('gives a handler counters and the owner: increment is atomic-shaped, isOwner tells the author apart', async () => {
    const s = service({
      'functions/next.js':
        'export default async (req, ctx) => ({ n: await ctx.store.increment("orders:next"), owner: ctx.visitor && ctx.visitor.isOwner, ownerId: ctx.owner.id });',
    });
    const a = await s.call('crux-1', 'next', { body: null, visitorId: 'v-9' });
    const b = await s.call('crux-1', 'next', {
      body: null,
      visitorId: 'author-1',
    });
    expect(a.body).toEqual({ n: 1, owner: false, ownerId: 'author-1' });
    expect(b.body).toEqual({ n: 2, owner: true, ownerId: 'author-1' });
  });

  it("is the crux's own API: any method, the rest of the path, the query and the headers reach req; text and redirects come back shaped", async () => {
    const s = service({
      'functions/orders.js':
        'export default async function (req, ctx) { if (req.method === "GET") return ctx.text("order " + req.params[0] + " for " + req.query.who, 200); if (req.method === "DELETE") return ctx.redirect("/gone", 303); return ctx.json({ ua: req.headers["user-agent"], path: req.path }, 201); }',
    });
    const get = await s.call('crux-1', 'orders', {
      body: null,
      visitorId: null,
      method: 'GET',
      rest: '42/items',
      query: { who: 'ada' },
    });
    expect(get).toMatchObject({
      status: 200,
      body: 'order 42 for ada',
      contentType: 'text/plain; charset=utf-8',
    });
    const del = await s.call('crux-1', 'orders', {
      body: null,
      visitorId: null,
      method: 'DELETE',
      rest: '42',
    });
    expect(del).toMatchObject({ status: 303, headers: { Location: '/gone' } });
    const post = await s.call('crux-1', 'orders', {
      body: {},
      visitorId: null,
      method: 'POST',
      rest: 'a/b',
      headers: { 'user-agent': 'curl' },
    });
    expect(post).toMatchObject({
      status: 201,
      body: { ua: 'curl', path: 'a/b' },
    });
  });

  it('reads publication-owned schedules and runs due handlers with ctx.event', async () => {
    const s = service({
      'functions/digest.js':
        'export const schedule = "every 10m";\nexport default async (req, ctx) => { await ctx.store.set("last-digest", ctx.event.data.at); return { ran: ctx.event.name }; }',
      'functions/bad.js':
        'export const schedule = "every 90m";\nexport default async () => 1;',
      'functions/hello.js': 'export default async () => 1;',
    });
    s.clock.table.set('crux-1|digest', {
      name: 'digest',
      schedule: '*/10 * * * *',
      nextRun: new Date('2026-09-29T12:00:00Z'),
    });
    const listed = await s.listWithSchedules('crux-1');
    expect(listed.find((f) => f.name === 'digest')).toMatchObject({
      schedule: '*/10 * * * *',
    });
    expect(listed.find((f) => f.name === 'bad')?.schedule).toBeUndefined();
    expect(listed.find((f) => f.name === 'digest')?.nextRun).toBeTruthy();
    expect(s.clock.table.size).toBe(1);

    // Nothing due yet, then the clock passes next_run.
    expect(await s.runDue(new Date('2020-01-01T00:00:00Z'))).toBe(0);
    const row = s.clock.table.get('crux-1|digest')!;
    const later = new Date(row.nextRun.getTime() + 1000);
    expect(await s.runDue(later)).toBe(1);
    expect(s.kvStore.get('last-digest')).toBe(later.toISOString());
    expect(row.status).toBe('200');
    expect(row.nextRun.getTime()).toBeGreaterThan(later.getTime());
    expect(s.metered.noteFunctionRun).toHaveBeenCalledWith(
      'crux-1',
      expect.any(Number),
    );
  });

  it.each(['database', 'storage'])(
    'retains schedules and retries next interval after a %s outage',
    async (boundary) => {
      const s = service({
        'functions/tick.js': 'export default () => ({ ok: true });',
      });
      const row = {
        name: 'tick',
        schedule: '* * * * *',
        nextRun: new Date('2026-09-29T12:00:00Z'),
      };
      s.clock.table.set('crux-1|tick', row);
      if (boundary === 'database')
        jest
          .spyOn(s.cruxLookup, 'findById')
          .mockRejectedValueOnce(new Error('Database unavailable'));
      else
        jest
          .spyOn(s.publishedFiles, 'download')
          .mockRejectedValueOnce(new Error('Storage unavailable'));
      await s.runDue(new Date('2026-09-29T12:00:00Z'));
      expect(s.clock.deleteSchedules).not.toHaveBeenCalled();
      expect(s.clock.table.get('crux-1|tick')).toMatchObject({
        status: expect.stringContaining('error:'),
      });
      await s.runDue(new Date('2026-09-29T12:01:00Z'));
      expect(s.clock.table.get('crux-1|tick')).toMatchObject({ status: '200' });
    },
  );

  it('keeps secrets encrypted at rest and hands them to handlers only', async () => {
    process.env.JWT_SECRET =
      process.env.JWT_SECRET || 'spec-secret-at-least-32-characters-long';
    const s = service({
      'functions/pay.js':
        'export default async (req, ctx) => ({ has: ctx.secrets.has("STRIPE"), len: (ctx.secrets.get("STRIPE") || "").length, none: ctx.secrets.get("NOPE") });',
    });
    await s.setSecret('crux-1', 'STRIPE', 'sk_test_123');
    const stored = s.clock.vault.get('STRIPE')!;
    expect(stored.ciphertext).not.toContain('sk_test');
    expect(await s.listSecretNames('crux-1')).toMatchObject([
      { name: 'STRIPE' },
    ]);
    const r = await s.call('crux-1', 'pay', { body: null, visitorId: null });
    expect(r.body).toEqual({ has: true, len: 11, none: null });
    await expect(s.setSecret('crux-1', 'bad name', 'x')).rejects.toThrow(
      /letters, digits/,
    );
    await s.deleteSecret('crux-1', 'STRIPE');
    expect(await s.listSecretNames('crux-1')).toEqual([]);
  });

  it('runs declared ctx.fetch requests through the isolate and real HTTP', async () => {
    const oldNursery = process.env.NURSERY_MODE;
    process.env.NURSERY_MODE = 'true';
    const lookup = jest
      .spyOn(dns, 'lookup')
      .mockResolvedValue([{ address: '127.0.0.1', family: 4 }] as never);
    const calls: string[] = [];
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      calls.push(
        `${req.method} ${req.url} ${Buffer.concat(chunks).toString()}`,
      );
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ pong: true }));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const port = (server.address() as AddressInfo).port;
    try {
      const s = service({
        'functions/egress.json': JSON.stringify({
          hosts: ['api.example.com', '*.stripe.com'],
        }),
        'functions/out.js':
          'export default async (req, ctx) => { const r = await ctx.fetch(req.body.url, { method: "POST", body: { a: 1 } }); return { status: r.status, data: await r.json() }; }',
      });
      for (const host of ['api.example.com', 'api.stripe.com']) {
        const result = await s.call('crux-1', 'out', {
          body: { url: `http://${host}:${port}/ping` },
          visitorId: null,
        });
        expect(result.body).toEqual({ status: 200, data: { pong: true } });
      }
      const no = await s.call('crux-1', 'out', {
        body: { url: 'https://evil.example.org/' },
        visitorId: null,
      });
      expect(no.status).toBe(403);
      expect(no.body).toEqual({
        error: expect.stringContaining('egress.json'),
      });
      expect(calls).toEqual(['POST /ping {"a":1}', 'POST /ping {"a":1}']);
      expect((await s.list('crux-1')).map((f) => f.name)).toEqual(['out']);
    } finally {
      if (oldNursery === undefined) delete process.env.NURSERY_MODE;
      else process.env.NURSERY_MODE = oldNursery;
      lookup.mockRestore();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.each(['private-dns', 'mapped-literal'])(
    'blocks %s egress even when the host is declared',
    async (kind) => {
      const lookup = jest
        .spyOn(dns, 'lookup')
        .mockResolvedValue([{ address: '127.0.0.1', family: 4 }] as never);
      const fetch = jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(new Response('internal service'));
      try {
        const host =
          kind === 'private-dns' ? 'internal.example.test' : '[::ffff:7f00:1]';
        const s = service({
          'functions/egress.json': JSON.stringify({ hosts: [host] }),
          'functions/out.js':
            'export default async (req, ctx) => { const r = await ctx.fetch(req.body.url); return await r.text(); }',
        });
        const response = await s.call('crux-1', 'out', {
          body: { url: `http://${host}/private` },
          visitorId: null,
        });
        expect(response.status).toBe(403);
        expect(fetch).not.toHaveBeenCalled();
      } finally {
        fetch.mockRestore();
        lookup.mockRestore();
      }
    },
  );

  it('keeps loaded code with its own egress policy when a newer publication fills the cache', async () => {
    const files = {
      'functions/egress.json': JSON.stringify({ hosts: ['old.example.com'] }),
      'functions/probe.js':
        'export default async (req, ctx) => { try { await ctx.fetch("https://new.example.com/"); } catch (e) { return { version: "old", error: e.message }; } };',
    };
    const svc = service(files);
    const execute = (svc as any).execute.bind(svc);
    let entered!: () => void, resume!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const intercepted = jest
      .spyOn(svc as any, 'execute')
      .mockImplementationOnce(async (...args: any[]) => {
        entered();
        await paused;
        return execute(...args);
      });
    const lookup = jest
      .spyOn(dns, 'lookup')
      .mockResolvedValue([{ address: '127.0.0.1', family: 4 }] as never);
    const old = svc.call('crux-1', 'probe', { body: null, visitorId: null });
    try {
      await started;
      files['functions/egress.json'] = JSON.stringify({
        hosts: ['new.example.com'],
      });
      files['functions/probe.js'] =
        'export default () => ({ version: "new" });';
      const current = await svc.cruxLookup.findById();
      current.meta.publishedVersion++;
      await svc.list('crux-1');
      resume();
      expect((await old).body).toEqual({
        version: 'old',
        error: expect.stringContaining('egress.json'),
      });
      expect(
        (await svc.call('crux-1', 'probe', { body: null, visitorId: null }))
          .body,
      ).toEqual({ version: 'new' });
    } finally {
      resume();
      await old;
      lookup.mockRestore();
      intercepted.mockRestore();
    }
  });

  it('meters every run, whatever it answered', async () => {
    const s = service({
      'functions/ok.js': 'export default async () => 1;',
      'functions/no.js': 'export default async (req, ctx) => ctx.reject("no");',
    });
    await s.call('crux-1', 'ok', { body: null, visitorId: null });
    await s.call('crux-1', 'no', { body: null, visitorId: null });
    expect(s.metered.noteFunctionRun).toHaveBeenCalledTimes(2);
    expect(s.metered.noteFunctionRun).toHaveBeenCalledWith(
      'crux-1',
      expect.any(Number),
    );
  });

  it('has nothing but the language in the sandbox', async () => {
    const s = service({
      'functions/peek.js':
        'export default function () { return { p: typeof process, r: typeof require, f: typeof fetch } }',
    });
    const r = await s.call('crux-1', 'peek', { body: null, visitorId: null });
    expect(r.body).toEqual({ p: 'undefined', r: 'undefined', f: 'undefined' });
  });

  it('emits an event: matching handlers run with ctx.event, the stream hears it', async () => {
    const store = new Map<string, unknown>();
    const s = service(
      {
        'functions/on-score.js':
          'export default async function (req, ctx) { await ctx.store.set("last", ctx.event.data.points); return "saw " + ctx.event.name }',
        'functions/on-anything.js':
          "export const match = '*';\nexport default function (req, ctx) { return ctx.event.name }",
        'functions/on-other.js':
          'export default function () { throw new Error("never") }',
      },
      store,
    );
    const heard: string[] = [];
    const sub = s.events.subscribe((e) =>
      heard.push(`${e.cruxId}:${e.event.name}`),
    );
    const r = await s.emit('crux-1', 'score', { points: 3 }, 'v-2');
    sub.unsubscribe();
    expect(r.handlers).toBe(2);
    expect(r.results['on-score'].body).toBe('saw score');
    expect(r.results['on-anything'].body).toBe('score');
    expect(store.get('last')).toBe(3);
    expect(heard).toEqual(['crux-1:score']);
  });

  it('cuts off a runaway handler and reports a broken one', async () => {
    const s = service({
      'functions/spin.js':
        'export default function () { return new Promise(() => {}) }',
      'functions/broken.js': 'export default 42',
    });
    const spun = await s.call('crux-1', 'spin', {
      body: null,
      visitorId: null,
    });
    expect(spun.status).toBe(504);
    expect((spun.body as { error: string }).error).toMatch(/ran past/);
    const r = await s.call('crux-1', 'broken', { body: null, visitorId: null });
    expect(r.status).toBe(500);
  }, 10000);

  it('matches names and prefixes', () => {
    expect(matches('score', 'score')).toBe(true);
    expect(matches('score*', 'score:saved')).toBe(true);
    expect(matches('*', 'anything')).toBe(true);
    expect(matches('score', 'scores')).toBe(false);
  });
});
