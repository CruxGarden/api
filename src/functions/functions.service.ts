import {
  BadRequestException,
  forwardRef,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Subject } from 'rxjs';
import * as vm from 'node:vm';
import { LoggerService } from '../common/services/logger.service';
import { StoreService as FileStore } from '../common/services/store.service';
import { PublishStorageService } from '../common/services/publish-storage.service';
import { CruxService } from '../crux/crux.service';
import { StoreService } from '../crux-store/crux-store.service';
import { ResourceType } from '../common/types/enums';

/**
 * Crux Functions (CRUX-FUNCTIONS-PLAN, ADR 0023 — F0 and F6): small handlers
 * a person or their agent writes into a crux's `functions/` folder, published
 * with the crux, run here by the API against the crux's own Store.
 *
 *   functions/hello.js        HTTP     POST /fn/<cruxId>/hello
 *   functions/on-score.js     event    runs when the crux emits "score"
 *                                      (a page's crux.emit, a Store write as
 *                                      "store:write", another handler's ctx.emit)
 *
 * A handler is `export default async function (req, ctx) {}`; an event
 * handler may also `export const match = 'score*'`. `ctx` is the whole world
 * it sees: `ctx.store` (get/set/list/del on this crux's Store, writes as the
 * visitor or, with none, as the crux's owner), `ctx.visitor`, `ctx.event`,
 * `ctx.emit`, `ctx.now()`, `ctx.log()`, `ctx.json()`, `ctx.reject()`.
 *
 * The sandbox is Node's `vm` with a bare context (no `require`, `process`,
 * `fetch` or filesystem) and a wall-clock budget; `isolated-vm` is the
 * hardening step the plan names for a public host.
 */
export interface FunctionSource {
  name: string;
  path: string;
  kind: 'http' | 'event';
  event?: string;
}

export interface CruxEvent {
  name: string;
  data: unknown;
  visitorId: string | null;
  at: string;
}

export interface RunResult {
  status: number;
  body: unknown;
  logs: string[];
  ms: number;
}

class FunctionReject extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const WALL_MS = 5000;
const MAX_CONCURRENT = 4;
const MAX_LOG_LINES = 50;

interface Loaded {
  version: unknown;
  sources: FunctionSource[];
  code: Map<string, string>;
}

@Injectable()
export class FunctionsService {
  private readonly logger: LoggerService;
  private readonly cache = new Map<string, Loaded>();
  private readonly running = new Map<string, number>();
  private readonly bus = new Subject<{ cruxId: string; event: CruxEvent }>();

  constructor(
    loggerService: LoggerService,
    private readonly files: FileStore,
    private readonly publishStorage: PublishStorageService,
    @Inject(forwardRef(() => CruxService))
    private readonly cruxService: CruxService,
    @Inject(forwardRef(() => StoreService))
    private readonly store: StoreService,
  ) {
    this.logger = loggerService.createChildLogger('FunctionsService');
  }

  /** The stream of a crux's events, for the SSE endpoint. */
  get events() {
    return this.bus.asObservable();
  }

  /** What a published crux's `functions/` folder holds. */
  async list(cruxId: string): Promise<FunctionSource[]> {
    return (await this.load(cruxId)).sources;
  }

  private async load(cruxId: string): Promise<Loaded> {
    const crux = await this.cruxService.findById(cruxId);
    if (!crux?.meta?.publishedAt)
      throw new NotFoundException('This crux is not published');
    const version = crux.meta.publishedVersion ?? crux.meta.publishedAt;
    const cached = this.cache.get(cruxId);
    if (cached && cached.version === version) return cached;
    const artifacts = await this.cruxService.getPublishedArtifacts(cruxId);
    const sources: FunctionSource[] = [];
    const code = new Map<string, string>();
    for (const a of artifacts) {
      const path = (a.meta as { path?: string } | null)?.path ?? a.filename;
      const m = /^functions\/([A-Za-z0-9._-]+)\.js$/.exec(path ?? '');
      if (!m) continue;
      const name = m[1];
      const bytes = await this.readPublished(crux.id, crux.meta, path);
      if (!bytes) continue;
      const event = name.startsWith('on-') ? name.slice(3) : undefined;
      sources.push({
        name,
        path,
        kind: event ? 'event' : 'http',
        ...(event ? { event } : {}),
      });
      code.set(name, bytes.toString('utf8'));
    }
    const loaded = { version, sources, code };
    this.cache.set(cruxId, loaded);
    return loaded;
  }

  private async readPublished(
    cruxId: string,
    meta: Record<string, any>,
    path: string,
  ): Promise<Buffer | null> {
    try {
      if (meta.publishLayout === 'bucket-per-crux') {
        const r = await this.files.download({
          namespace: this.publishStorage.bucketName(cruxId),
          path,
        });
        return r.data;
      }
      const r = await this.files.download({
        namespace:
          process.env.AWS_S3_PUBLISHED_BUCKET || 'crux-garden-published',
        path: `${cruxId}/${path}`,
      });
      return r.data;
    } catch (error) {
      this.logger.warn(`Could not read ${path}: ${(error as Error).message}`, {
        cruxId,
      });
      return null;
    }
  }

  /** Run an HTTP handler: POST /fn/:cruxId/:name. */
  async call(
    cruxId: string,
    name: string,
    input: { body: unknown; visitorId: string | null; method?: string },
  ): Promise<RunResult> {
    const loaded = await this.load(cruxId);
    const source = loaded.sources.find((s) => s.name === name);
    if (!source || source.kind !== 'http')
      throw new NotFoundException(`No function "${name}" in this crux`);
    return this.execute(cruxId, name, loaded.code.get(name)!, {
      req: {
        method: input.method ?? 'POST',
        body: input.body,
        json: async () => input.body,
      },
      visitorId: input.visitorId,
    });
  }

  /**
   * Emit an event on a crux: every `on-<event>.js` whose name (or exported
   * `match` pattern) fits runs with `ctx.event`, then the event reaches the
   * pages listening on the stream.
   */
  async emit(
    cruxId: string,
    name: string,
    data: unknown,
    visitorId: string | null,
    depth = 0,
  ): Promise<{ handlers: number; results: Record<string, RunResult> }> {
    const event: CruxEvent = {
      name,
      data,
      visitorId,
      at: new Date().toISOString(),
    };
    const results: Record<string, RunResult> = {};
    let handlers = 0;
    if (depth < 3) {
      const loaded = await this.load(cruxId).catch(() => null);
      for (const source of loaded?.sources ?? []) {
        if (source.kind !== 'event') continue;
        const code = loaded!.code.get(source.name)!;
        const pattern = this.matchOf(code) ?? source.event!;
        if (!matches(pattern, name)) continue;
        handlers++;
        results[source.name] = await this.execute(cruxId, source.name, code, {
          req: { method: 'EVENT', body: data, json: async () => data },
          visitorId,
          event,
          depth: depth + 1,
        }).catch((error) => ({
          status: error instanceof FunctionReject ? error.status : 500,
          body: { error: (error as Error).message },
          logs: [],
          ms: 0,
        }));
      }
    }
    this.bus.next({ cruxId, event });
    return { handlers, results };
  }

  private matchOf(code: string): string | null {
    const m = /export\s+const\s+match\s*=\s*(['"`])([^'"`]+)\1/.exec(code);
    return m ? m[2] : null;
  }

  private async execute(
    cruxId: string,
    name: string,
    code: string,
    input: {
      req: { method: string; body: unknown; json: () => Promise<unknown> };
      visitorId: string | null;
      event?: CruxEvent;
      depth?: number;
    },
  ): Promise<RunResult> {
    const inFlight = this.running.get(cruxId) ?? 0;
    if (inFlight >= MAX_CONCURRENT)
      throw new ServiceUnavailableException(
        'This crux is running as many functions as it may at once',
      );
    this.running.set(cruxId, inFlight + 1);
    const started = Date.now();
    const logs: string[] = [];
    try {
      const crux = await this.cruxService.findById(cruxId);
      const handler = this.compile(name, code);
      const ctx = this.context(crux, input, logs);
      const outcome = await withBudget(
        Promise.resolve(handler(input.req, ctx)),
        WALL_MS,
        name,
      );
      const body =
        outcome && typeof outcome === 'object' && '__json' in outcome
          ? (outcome as { __json: unknown }).__json
          : (outcome ?? null);
      return { status: 200, body, logs, ms: Date.now() - started };
    } catch (error) {
      if (error instanceof FunctionReject)
        return {
          status: error.status,
          body: { error: error.message },
          logs,
          ms: Date.now() - started,
        };
      this.logger.warn(`Function ${name} failed: ${(error as Error).message}`, {
        cruxId,
      });
      throw new BadRequestException(
        `Function "${name}" failed: ${(error as Error).message}`,
      );
    } finally {
      this.running.set(cruxId, (this.running.get(cruxId) ?? 1) - 1);
    }
  }

  /**
   * The handler as a callable: its ESM exports become `module.exports`, and
   * it is compiled in a bare context — no `require`, `process`, `fetch`,
   * timers or filesystem; only the language.
   */
  private compile(
    name: string,
    code: string,
  ): (req: unknown, ctx: unknown) => unknown {
    const cjs = code
      .replace(
        /export\s+default\s+async\s+function/g,
        'module.exports.default = async function',
      )
      .replace(
        /export\s+default\s+function/g,
        'module.exports.default = function',
      )
      .replace(/export\s+default\s+/g, 'module.exports.default = ')
      .replace(
        /export\s+(const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g,
        'module.exports.$2 =',
      )
      .replace(
        /export\s+async\s+function\s+([A-Za-z_$][\w$]*)/g,
        'module.exports.$1 = async function $1',
      )
      .replace(
        /export\s+function\s+([A-Za-z_$][\w$]*)/g,
        'module.exports.$1 = function $1',
      );
    const sandbox: Record<string, unknown> = { module: { exports: {} } };
    vm.createContext(sandbox, { name: `crux-function:${name}` });
    try {
      vm.runInContext(cjs, sandbox, {
        filename: `${name}.js`,
        timeout: 200,
      });
    } catch (error) {
      throw new FunctionReject(
        `"${name}" could not be loaded: ${(error as Error).message}`,
        500,
      );
    }
    const exported = (sandbox.module as { exports: Record<string, unknown> })
      .exports;
    const fn = exported.default;
    if (typeof fn !== 'function')
      throw new FunctionReject(`"${name}" has no default export`, 500);
    return fn as (req: unknown, ctx: unknown) => unknown;
  }

  private context(
    crux: { id: string; authorId: string },
    input: { visitorId: string | null; event?: CruxEvent; depth?: number },
    logs: string[],
  ) {
    const cruxId = crux.id;
    const visitorId = input.visitorId;
    const writer = visitorId ?? crux.authorId;
    return Object.freeze({
      visitor: visitorId ? { id: visitorId } : null,
      event: input.event ?? null,
      now: () => new Date().toISOString(),
      log: (...parts: unknown[]) => {
        if (logs.length < MAX_LOG_LINES)
          logs.push(
            parts
              .map((p) => (typeof p === 'string' ? p : JSON.stringify(p)))
              .join(' '),
          );
      },
      json: (value: unknown) => ({ __json: value }),
      reject: (message: string, status = 400) => {
        throw new FunctionReject(String(message), status);
      },
      emit: (name: string, data: unknown) =>
        this.emit(
          cruxId,
          String(name),
          data,
          visitorId,
          (input.depth ?? 0) + 1,
        ),
      store: Object.freeze({
        get: async (key: string) =>
          (await this.store.get(cruxId, String(key), visitorId))?.value ?? null,
        set: async (
          key: string,
          value: unknown,
          mode: 'public' | 'protected' = 'public',
        ) =>
          (
            await this.store.serverSet(
              cruxId,
              crux.authorId,
              String(key),
              value,
              mode,
              writer,
            )
          ).value,
        list: async (prefix = '') =>
          (await this.store.list(cruxId))
            .filter((e) => e.key.startsWith(String(prefix)))
            .map((e) => ({ key: e.key, value: e.value, mode: e.mode })),
        del: async (key: string) => this.store.delete(cruxId, String(key)),
      }),
    });
  }
}

/** `score*` matches `score` and `score:saved`; `*` matches everything. */
export function matches(pattern: string, name: string): boolean {
  if (pattern === '*' || pattern === name) return true;
  if (pattern.endsWith('*')) return name.startsWith(pattern.slice(0, -1));
  return false;
}

function withBudget<T>(p: Promise<T>, ms: number, name: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(
        () => reject(new FunctionReject(`"${name}" ran past ${ms} ms`, 504)),
        ms,
      );
    }),
  ]);
}

export { ResourceType as _ResourceType };
