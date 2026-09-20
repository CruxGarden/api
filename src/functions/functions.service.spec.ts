import { FunctionsService, matches } from './functions.service';

/**
 * The runner, with the crux, its published files and its Store faked:
 * a handler runs in a bare context against `ctx`, an event reaches the
 * handlers whose name or `match` fits, a bad handler answers 400, a
 * runaway one is cut off, and a page's stream hears the event.
 */
function service(
  files: Record<string, string>,
  store = new Map<string, unknown>(),
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
    meta: { publishedAt: '2026-09-20T00:00:00Z', publishedVersion: 3 },
  };
  const artifacts = Object.keys(files).map((path, i) => ({
    id: `a${i}`,
    filename: path.split('/').pop(),
    meta: { path },
  }));
  const fileStore = {
    download: async ({ path }: { path: string }) => {
      const key = path.replace(/^crux-1\//, '');
      if (!(key in files)) throw new Error('missing');
      return { data: Buffer.from(files[key]) };
    },
  };
  const publishStorage = { bucketName: (id: string) => `crux-${id}` };
  const cruxService = {
    findById: async () => crux,
    getPublishedArtifacts: async () => artifacts,
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
    syncSchedules: jest.fn(
      async (
        cruxId: string,
        rows: { name: string; schedule: string; nextRun: Date }[],
      ) => {
        for (const k of [...table.keys()])
          if (!rows.some((r) => `${cruxId}|${r.name}` === k)) table.delete(k);
        for (const r of rows) {
          const k = `${cruxId}|${r.name}`;
          const prev = table.get(k);
          table.set(k, prev && prev.schedule === r.schedule ? prev : { ...r });
        }
        return { data: undefined };
      },
    ),
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
  });
}

describe('Crux Functions runner', () => {
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

  it('declares schedules when the folder loads, runs the due ones on the clock with ctx.event, and drops an unpublished crux', async () => {
    const s = service({
      'functions/digest.js':
        'export const schedule = "every 10m";\nexport default async (req, ctx) => { await ctx.store.set("last-digest", ctx.event.data.at); return { ran: ctx.event.name }; }',
      'functions/bad.js':
        'export const schedule = "every 90m";\nexport default async () => 1;',
      'functions/hello.js': 'export default async () => 1;',
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

  it('reaches out only to the hosts functions/egress.json names, never the private network', async () => {
    const realFetch = global.fetch;
    const calls: string[] = [];
    global.fetch = jest.fn(async (url: any) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ pong: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as any;
    try {
      const s = service({
        'functions/egress.json': JSON.stringify({
          hosts: ['api.example.com', '*.stripe.com'],
        }),
        'functions/out.js':
          'export default async (req, ctx) => { const r = await ctx.fetch(req.body.url, { method: "POST", body: { a: 1 } }); return { status: r.status, data: await r.json() }; }',
      });
      const ok = await s.call('crux-1', 'out', {
        body: { url: 'https://api.example.com/ping' },
        visitorId: null,
      });
      expect(ok.body).toEqual({ status: 200, data: { pong: true } });
      const sub = await s.call('crux-1', 'out', {
        body: { url: 'https://api.stripe.com/v1/x' },
        visitorId: null,
      });
      expect(sub.status).toBe(200);
      const no = await s.call('crux-1', 'out', {
        body: { url: 'https://evil.example.org/' },
        visitorId: null,
      });
      expect(no.status).toBe(403);
      expect(String((no.body as { error: string }).error)).toMatch(
        /egress\.json/,
      );
      const priv = await s.call('crux-1', 'out', {
        body: { url: 'http://169.254.169.254/latest' },
        visitorId: null,
      });
      expect(priv.status).toBe(403);
      expect(calls).toHaveLength(2);
      // "secrets" is the API's own route, never a handler
      expect((await s.list('crux-1')).map((f) => f.name)).toEqual(['out']);
    } finally {
      global.fetch = realFetch;
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
