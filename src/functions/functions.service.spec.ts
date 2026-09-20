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
    createChildLogger: () => ({ warn: jest.fn(), info: jest.fn() }),
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
  };
  return new FunctionsService(
    logger as any,
    fileStore as any,
    publishStorage as any,
    cruxService as any,
    kv as any,
  );
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
