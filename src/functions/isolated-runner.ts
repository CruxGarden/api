import * as ivm from 'isolated-vm';
import { compileToCjs } from './compiler';

const MAX_TRANSFER = 1024 * 1024;
const MAX_CALLS = 1000;
export class IsolatedFunctionError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Only copied JSON values and explicit callbacks cross the isolate boundary. */
export async function runIsolatedFunction(
  name: string,
  code: string,
  req: {
    body?: unknown;
    json(): Promise<unknown>;
    text?: () => Promise<string>;
    [key: string]: unknown;
  },
  ctx: Record<string, any>,
  budgetMs: number,
): Promise<unknown> {
  if (Buffer.byteLength(code) > 256 * 1024)
    throw new Error('Function source exceeds 256 KB');
  const compiled = compileToCjs(code);
  const encode = (value: unknown): string => {
    const json = JSON.stringify(value);
    if (json && Buffer.byteLength(json) > MAX_TRANSFER)
      throw new Error('Function transfer exceeds 1 MB');
    return json;
  };
  const isolate = new ivm.Isolate({ memoryLimit: 32 });
  let alive = true;
  let calls = 0;
  let timer: NodeJS.Timeout | undefined;
  const check = () => {
    if (!alive) throw new Error('Function execution has ended');
    if (++calls > MAX_CALLS) throw new Error('Function made too many calls');
  };
  const decode = (payload: string): unknown[] => {
    check();
    if (
      typeof payload !== 'string' ||
      Buffer.byteLength(payload) > MAX_TRANSFER
    )
      throw new Error('Invalid function arguments');
    const args = JSON.parse(payload);
    if (!Array.isArray(args)) throw new Error('Invalid function arguments');
    return args;
  };
  const failure = (error: any) =>
    encode({
      error: String(error?.message || error),
      status: typeof error?.status === 'number' ? error.status : undefined,
    });
  const sync = new ivm.Callback((op: string, payload: string) => {
    try {
      const args = decode(payload);
      let value: unknown;
      switch (op) {
        case 'secrets.get':
          value = ctx.secrets.get(...args);
          break;
        case 'secrets.has':
          value = ctx.secrets.has(...args);
          break;
        case 'log':
          value = ctx.log(...args);
          break;
        default:
          throw new Error('Unsupported function operation');
      }
      return encode({ value });
    } catch (error) {
      return failure(error);
    }
  });
  const asyncCall = new ivm.Reference(async (op: string, payload: string) => {
    try {
      const args = decode(payload);
      let value: unknown;
      switch (op) {
        case 'store.get':
          value = await ctx.store.get(...args);
          break;
        case 'store.set':
          value = await ctx.store.set(...args);
          break;
        case 'store.increment':
          value = await ctx.store.increment(...args);
          break;
        case 'store.list':
          value = await ctx.store.list(...args);
          break;
        case 'store.del':
          value = await ctx.store.del(...args);
          break;
        case 'emit':
          value = await ctx.emit(...args);
          break;
        case 'fetch': {
          const response = await ctx.fetch(...args);
          value = {
            ok: response.ok,
            status: response.status,
            headers: response.headers,
            body: await response.text(),
          };
          break;
        }
        default:
          throw new Error('Unsupported function operation');
      }
      return encode({ value });
    } catch (error) {
      return failure(error);
    }
  });
  try {
    const context = await isolate.createContext();
    const request = encode({
      ...req,
      jsonBody: await req.json(),
      textBody: req.text ? await req.text() : JSON.stringify(req.body ?? null),
    });
    const state = encode({
      crux: ctx.crux,
      visitor: ctx.visitor,
      owner: ctx.owner,
      event: ctx.event,
    });
    const execution = context.evalClosure(
      `
      const request = JSON.parse($0);
      const state = JSON.parse($1);
      const unpack = raw => {
        const result = JSON.parse(raw);
        if (result.error) { const error = new Error(result.error); error.status = result.status; throw error; }
        return result.value;
      };
      const call = (op, ...args) => unpack($2(op, JSON.stringify(args)));
      const callAsync = async (op, ...args) => unpack(await $3.apply(undefined, [op, JSON.stringify(args)], { arguments: { copy: true }, result: { promise: true, copy: true } }));
      const req = { ...request, json: async () => request.jsonBody, text: async () => request.textBody };
      delete req.jsonBody; delete req.textBody;
      const ctx = Object.freeze({ ...state,
        now: () => new Date().toISOString(),
        log: (...args) => call('log', ...args),
        secrets: Object.freeze({ get: name => call('secrets.get', name), has: name => call('secrets.has', name) }),
        store: Object.freeze(Object.fromEntries(['get','set','increment','list','del'].map(op => [op, (...args) => callAsync('store.' + op, ...args)]))),
        emit: (...args) => callAsync('emit', ...args),
        fetch: async (...args) => { const result = await callAsync('fetch', ...args); return { ok: result.ok, status: result.status, headers: result.headers, text: async () => result.body, json: async () => JSON.parse(result.body) }; },
        json: (value, status = 200) => ({ __json: value, __status: status }),
        text: (body, status = 200, type = 'text/plain; charset=utf-8') => ({ __text: String(body ?? ''), __status: status, __type: type }),
        html: (body, status = 200) => ({ __text: String(body ?? ''), __status: status, __type: 'text/html; charset=utf-8' }),
        redirect: (url, status = 302) => ({ __text: '', __status: status, __headers: { Location: String(url) } }),
        reject: (message, status = 400) => { const error = new Error(String(message)); error.status = status; throw error; },
      });
      return (async () => {
        try {
          const module = { exports: {} };
          new Function('module', 'exports', ${JSON.stringify(compiled)})(module, module.exports);
          const handler = module.exports.default;
          if (typeof handler !== 'function') { const error = new Error('Function has no default export'); error.status = 500; throw error; }
          return JSON.stringify({ value: await handler(req, ctx) });
        } catch (error) { return JSON.stringify({ error: String(error.message || error), status: error.status }); }
      })();
    `,
      [request, state, sync, asyncCall],
      { timeout: budgetMs, result: { promise: true, copy: true } },
    );
    const raw = await Promise.race([
      execution,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          alive = false;
          isolate.dispose();
          reject(
            new IsolatedFunctionError(`"${name}" ran past ${budgetMs} ms`, 504),
          );
        }, budgetMs);
      }),
    ]);
    if (typeof raw !== 'string' || Buffer.byteLength(raw) > MAX_TRANSFER)
      throw new Error('Function result exceeds 1 MB');
    const result = JSON.parse(raw);
    if (result.error) {
      if (typeof result.status === 'number')
        throw new IsolatedFunctionError(result.error, result.status);
      throw new Error(result.error);
    }
    return result.value;
  } catch (error) {
    if (
      error instanceof Error &&
      /timed out|Isolate was disposed/.test(error.message)
    )
      throw new IsolatedFunctionError(`"${name}" ran past ${budgetMs} ms`, 504);
    throw error;
  } finally {
    alive = false;
    clearTimeout(timer);
    if (!isolate.isDisposed) isolate.dispose();
  }
}
