import { runIsolatedFunction } from './isolated-runner';
const request = () => ({
  method: 'POST',
  body: { count: 2 },
  json: async () => ({ count: 2 }),
  text: async () => '{"count":2}',
});
const context = () => ({
  crux: { id: 'crux-1' },
  owner: { id: 'owner-1' },
  visitor: { id: 'visitor-1', isOwner: false },
  event: null,
  log: jest.fn(),
  secrets: { get: () => 'fixture-only', has: () => true },
  store: {
    get: jest.fn(async () => 4),
    set: jest.fn(async (_key: string, value: unknown) => value),
    increment: jest.fn(async () => 5),
    list: jest.fn(async () => []),
    del: jest.fn(async () => undefined),
  },
  emit: jest.fn(async () => undefined),
  fetch: jest.fn(async () => ({
    ok: true,
    status: 200,
    headers: {},
    text: async () => '{"answer":42}',
  })),
});
describe('isolated Function boundary', () => {
  it('supports request data, scoped async Store calls, response helpers and secrets', async () => {
    const ctx = context();
    const result = await runIsolatedFunction(
      'copy',
      `export default async function(req, ctx) {
      const body = await req.json(); const value = await ctx.store.get('count');
      await ctx.store.set('count', value + body.count);
      const response = await ctx.fetch('https://example.test');
      return ctx.json({ value: value + body.count, secret: ctx.secrets.get('key'), response: await response.json() }, 201);
    }`,
      request(),
      ctx,
      1000,
    );
    expect(result).toEqual({
      __json: { value: 6, secret: 'fixture-only', response: { answer: 42 } },
      __status: 201,
    });
    expect(ctx.store.set).toHaveBeenCalledWith('count', 6);
  });
  it('does not expose host process through callbacks, request objects, results or module objects', async () => {
    const result = await runIsolatedFunction(
      'escape',
      `export default async function(req, ctx) {
      const value = await ctx.store.list();
      return [typeof process, ctx.log.constructor('return typeof process')(), req.constructor.constructor('return typeof process')(), value.constructor.constructor('return typeof process')(), module.constructor.constructor('return typeof process')()];
    }`,
      request(),
      context(),
      1000,
    );
    expect(result).toEqual([
      'undefined',
      'undefined',
      'undefined',
      'undefined',
      'undefined',
    ]);
  });
  it.each([
    'export default function() { while (true) {} }',
    'export default async function() { await Promise.resolve(); while (true) {} }',
    'export default async function() { await new Promise(() => {}); }',
  ])(
    'terminates runaway or unresolved work without blocking the host: %s',
    async (code) => {
      const started = Date.now();
      await expect(
        runIsolatedFunction('budget', code, request(), context(), 40),
      ).rejects.toMatchObject({ status: 504 });
      expect(Date.now() - started).toBeLessThan(1500);
      await expect(
        runIsolatedFunction(
          'next',
          'export default () => 7',
          request(),
          context(),
          1000,
        ),
      ).resolves.toBe(7);
    },
  );
  it('preserves explicit rejections and refuses host operations outside the allowlist', async () => {
    await expect(
      runIsolatedFunction(
        'reject',
        "export default (req, ctx) => ctx.reject('No access', 403)",
        request(),
        context(),
        1000,
      ),
    ).rejects.toMatchObject({ message: 'No access', status: 403 });
    await expect(
      runIsolatedFunction(
        'unsupported',
        'export default () => [typeof $2, typeof $3]',
        request(),
        context(),
        1000,
      ),
    ).resolves.toEqual(['undefined', 'undefined']);
  });
});
