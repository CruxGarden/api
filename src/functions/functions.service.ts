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
import { UsageService } from '../usage/usage.service';
import {
  FunctionsRepository,
  FunctionScheduleRow,
} from './functions.repository';
import { cronError, nextCron, normalizeSchedule } from './cron';
import {
  decryptSecret,
  egressAllowed,
  encryptSecret,
  isPrivateHost,
} from './secrets';

/**
 * Crux Functions (CRUX-FUNCTIONS-PLAN, ADR 0023 — F0 and F6): small handlers
 * a person or their agent writes into a crux's `functions/` folder, published
 * with the crux, run here by the API against the crux's own Store.
 *
 *   functions/hello.js        HTTP     any method at /fn/<cruxId>/hello[/rest]
 *   functions/on-score.js     event    runs when the crux emits "score"
 *                                      (a page's crux.emit, a Store write as
 *                                      "store:write", another handler's ctx.emit)
 *   functions/digest.js       schedule `export const schedule = '0 9 * * *'`
 *                                      (or 'every 10m'): runs on the API's clock
 *                                      with ctx.event = { name: 'schedule' } (F3)
 *
 * A handler is `export default async function (req, ctx) {}`; an event
 * handler may also `export const match = 'score*'`. `ctx` is the whole world
 * it sees: `ctx.store` (get/set/list/del on this crux's Store, writes as the
 * visitor or, with none, as the crux's owner), `ctx.visitor`, `ctx.event`,
 * `ctx.emit`, `ctx.now()`, `ctx.log()`, `ctx.json()`, `ctx.reject()`; `ctx.owner`
 * and `ctx.visitor.isOwner` tell a handler whether the caller is the crux's author.
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
  /** A cron expression (or `every <n>m|h|d`) the handler also runs on. */
  schedule?: string;
  /** When the scheduler will run it next, once the crux is published. */
  nextRun?: string | null;
  lastRun?: string | null;
  lastStatus?: string | null;
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
  /** For an HTTP answer that is not JSON: the body's media type (text/plain, text/html…). */
  contentType?: string;
  headers?: Record<string, string>;
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
  /** Hosts `ctx.fetch` may reach: `functions/egress.json` → `{ "hosts": [...] }`. */
  egress: string[];
}

const FETCH_MS = 4000;
const FETCH_MAX_BYTES = 1_000_000;
/** Handler names the API keeps for itself. */
export const RESERVED_NAMES = new Set(['secrets']);

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
    @Inject(forwardRef(() => UsageService))
    private readonly usage: UsageService,
    private readonly schedules: FunctionsRepository,
  ) {
    this.logger = loggerService.createChildLogger('FunctionsService');
  }

  // ── Schedules (F3) ────────────────────────────────────────────────────
  private ticker: ReturnType<typeof setInterval> | null = null;
  tickMs = 30_000;

  startScheduler(): void {
    if (this.ticker) return;
    this.ticker = setInterval(() => void this.runDue(), this.tickMs);
  }
  stopScheduler(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
  }

  /** Run every scheduled handler that is due; each firing is one metered run. */
  async runDue(now = new Date()): Promise<number> {
    const claimed = await this.schedules.claimDue(now, (row) =>
      nextCron(row.schedule, now),
    );
    if (claimed.error || !claimed.data) return 0;
    let ran = 0;
    for (const row of claimed.data) {
      const status = await this.fire(row, now);
      await this.schedules.setStatus(row.crux_id, row.name, status);
      ran += 1;
    }
    return ran;
  }

  private async fire(row: FunctionScheduleRow, now: Date): Promise<string> {
    let loaded: Loaded;
    try {
      loaded = await this.load(row.crux_id);
    } catch {
      // Unpublished or gone: its schedules go with it.
      await this.schedules.deleteSchedules(row.crux_id);
      return 'unpublished';
    }
    const code = loaded.code.get(row.name);
    if (!code) return 'missing';
    const event: CruxEvent = {
      name: 'schedule',
      data: { schedule: row.schedule, at: now.toISOString(), name: row.name },
      visitorId: null,
      at: now.toISOString(),
    };
    try {
      const r = await this.execute(row.crux_id, row.name, code, {
        req: { method: 'SCHEDULE', body: null, json: async () => null },
        visitorId: null,
        event,
      });
      this.bus.next({ cruxId: row.crux_id, event });
      return `${r.status}`;
    } catch (error) {
      return `error: ${(error as Error).message}`.slice(0, 200);
    }
  }

  // ── Secrets (F1) ──────────────────────────────────────────────────────
  async setSecret(cruxId: string, name: string, value: string): Promise<void> {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name))
      throw new BadRequestException(
        'A secret name is letters, digits and underscores (≤64)',
      );
    if (typeof value !== 'string' || !value || value.length > 8192)
      throw new BadRequestException('A secret is a string of up to 8 KB');
    const r = await this.schedules.putSecret(
      cruxId,
      name,
      encryptSecret(value),
    );
    if (r.error)
      throw new ServiceUnavailableException('Could not save the secret');
  }
  async deleteSecret(cruxId: string, name: string): Promise<void> {
    await this.schedules.deleteSecret(cruxId, name);
  }
  async listSecretNames(
    cruxId: string,
  ): Promise<{ name: string; updated: string }[]> {
    const rows = (await this.schedules.secretsFor(cruxId)).data ?? [];
    return rows
      .map((r) => ({
        name: r.name,
        updated: new Date(r.updated).toISOString(),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  private async secretsMap(cruxId: string): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const r of (await this.schedules.secretsFor(cruxId)).data ?? []) {
      try {
        out.set(r.name, decryptSecret(r));
      } catch {
        this.logger.warn(`secret ${r.name} does not decrypt (key rotated?)`, {
          cruxId,
        });
      }
    }
    return out;
  }

  /** `export const schedule = '…'` in a handler, validated. */
  private scheduleOf(code: string): string | null {
    const m = /export\s+const\s+schedule\s*=\s*(['"`])([^'"`]+)\1/.exec(code);
    if (!m) return null;
    const expr = m[2].trim();
    return cronError(expr) ? null : normalizeSchedule(expr);
  }

  /** The table mirrors what the published folder declares. */
  private async syncSchedules(cruxId: string, loaded: Loaded): Promise<void> {
    const now = new Date();
    const rows = loaded.sources
      .filter((s) => s.schedule)
      .map((s) => ({
        name: s.name,
        schedule: s.schedule!,
        nextRun:
          nextCron(s.schedule!, now) ?? new Date(now.getTime() + 86_400_000),
      }));
    await this.schedules.syncSchedules(cruxId, rows);
  }

  /** What a published crux's handlers run on, with when-next, for the Share pane. */
  async listWithSchedules(cruxId: string): Promise<FunctionSource[]> {
    const loaded = await this.load(cruxId);
    const rows = (await this.schedules.listSchedules(cruxId)).data ?? [];
    return loaded.sources.map((s) => {
      const row = rows.find((r) => r.name === s.name);
      return row
        ? {
            ...s,
            nextRun: new Date(row.next_run).toISOString(),
            lastRun: row.last_run ? new Date(row.last_run).toISOString() : null,
            lastStatus: row.last_status,
          }
        : s;
    });
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
    let egress: string[] = [];
    for (const a of artifacts) {
      const path = (a.meta as { path?: string } | null)?.path ?? a.filename;
      if (path === 'functions/egress.json') {
        const bytes = await this.readPublished(crux.id, crux.meta, path);
        try {
          const parsed = JSON.parse(bytes?.toString('utf8') ?? '{}');
          if (Array.isArray(parsed?.hosts))
            egress = parsed.hosts.filter((h: unknown) => typeof h === 'string');
        } catch {
          this.logger.warn('functions/egress.json is not JSON', { cruxId });
        }
        continue;
      }
      const m = /^functions\/([A-Za-z0-9._-]+)\.js$/.exec(path ?? '');
      if (!m) continue;
      const name = m[1];
      if (RESERVED_NAMES.has(name)) continue;
      const bytes = await this.readPublished(crux.id, crux.meta, path);
      if (!bytes) continue;
      const event = name.startsWith('on-') ? name.slice(3) : undefined;
      const text = bytes.toString('utf8');
      const schedule = this.scheduleOf(text);
      sources.push({
        name,
        path,
        kind: event ? 'event' : 'http',
        ...(event ? { event } : {}),
        ...(schedule ? { schedule } : {}),
      });
      code.set(name, text);
    }
    const loaded = { version, sources, code, egress };
    this.cache.set(cruxId, loaded);
    // A new published version re-declares its schedules.
    await this.syncSchedules(cruxId, loaded);
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
    input: {
      body: unknown;
      visitorId: string | null;
      method?: string;
      /** The path after the handler's name: `/fn/<id>/orders/42/items` → `42/items`. */
      rest?: string;
      query?: Record<string, string | string[]>;
      headers?: Record<string, string>;
    },
  ): Promise<RunResult> {
    const loaded = await this.load(cruxId);
    const source = loaded.sources.find((s) => s.name === name);
    if (!source || source.kind !== 'http')
      throw new NotFoundException(`No function "${name}" in this crux`);
    const body = input.body;
    return this.execute(cruxId, name, loaded.code.get(name)!, {
      req: {
        method: input.method ?? 'POST',
        body,
        json: async () => body,
        text: async () =>
          body == null
            ? ''
            : typeof body === 'string'
              ? body
              : JSON.stringify(body),
        path: input.rest ?? '',
        params: (input.rest ?? '').split('/').filter(Boolean),
        query: input.query ?? {},
        headers: input.headers ?? {},
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
      req: {
        method: string;
        body: unknown;
        json: () => Promise<unknown>;
        text?: () => Promise<string>;
        path?: string;
        params?: string[];
        query?: Record<string, string | string[]>;
        headers?: Record<string, string>;
      };
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
      const egress = this.cache.get(cruxId)?.egress ?? [];
      const secrets = /ctx\.secrets/.test(code)
        ? await this.secretsMap(cruxId)
        : new Map<string, string>();
      const ctx = this.context(crux, input, logs, { egress, secrets });
      const outcome = await withBudget(
        Promise.resolve(handler(input.req, ctx)),
        WALL_MS,
        name,
      );
      return { ...answerOf(outcome), logs, ms: Date.now() - started };
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
      // A run consumes usage whatever it answered (CRUX-FUNCTIONS-PLAN metering).
      this.usage.noteFunctionRun(cruxId, Date.now() - started);
    }
  }

  /**
   * `ctx.fetch` (F1): outbound only to the hosts `functions/egress.json`
   * names, never to the API's own network, four seconds, a megabyte back.
   * The answer is a small object the sandbox can hold: status, headers,
   * text(), json(). In nursery mode (one machine, no public reach) the local
   * addresses are allowed so a garden can talk to its own API.
   */
  private async egressFetch(
    cruxId: string,
    egress: string[],
    url: string,
    init?: Record<string, unknown>,
  ): Promise<{
    ok: boolean;
    status: number;
    headers: Record<string, string>;
    text: () => Promise<string>;
    json: () => Promise<unknown>;
  }> {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      throw new FunctionReject(`fetch: "${url}" is not a URL`, 400);
    }
    if (target.protocol !== 'https:' && target.protocol !== 'http:')
      throw new FunctionReject('fetch: only http and https', 400);
    const local = process.env.NURSERY_MODE === 'true';
    if (!local && isPrivateHost(target.hostname))
      throw new FunctionReject(
        `fetch: ${target.hostname} is not reachable`,
        403,
      );
    if (!egressAllowed(target.hostname, egress))
      throw new FunctionReject(
        `fetch: ${target.hostname} is not in functions/egress.json ("hosts")`,
        403,
      );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_MS);
    try {
      const method = String(init?.method ?? 'GET').toUpperCase();
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(
        (init?.headers as Record<string, unknown>) ?? {},
      ))
        headers[k] = String(v);
      const body =
        init?.body === undefined || init?.body === null
          ? undefined
          : typeof init.body === 'string'
            ? init.body
            : JSON.stringify(init.body);
      if (
        body !== undefined &&
        !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')
      )
        headers['content-type'] = 'application/json';
      const res = await fetch(target, {
        method,
        headers,
        body,
        signal: controller.signal,
        redirect: 'manual',
      });
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > FETCH_MAX_BYTES)
        throw new FunctionReject('fetch: the answer is over 1 MB', 502);
      const text = buf.toString('utf8');
      const outHeaders: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        outHeaders[k] = v;
      });
      this.logger.debug(`fetch ${method} ${target.host} → ${res.status}`, {
        cruxId,
      });
      return {
        ok: res.ok,
        status: res.status,
        headers: outHeaders,
        text: async () => text,
        json: async () => JSON.parse(text) as unknown,
      };
    } catch (error) {
      if (error instanceof FunctionReject) throw error;
      throw new FunctionReject(
        `fetch: ${(error as Error).name === 'AbortError' ? 'timed out' : (error as Error).message}`,
        502,
      );
    } finally {
      clearTimeout(timer);
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
    world: { egress: string[]; secrets: Map<string, string> } = {
      egress: [],
      secrets: new Map(),
    },
  ) {
    const cruxId = crux.id;
    const fetchOut = async (url: string, init?: Record<string, unknown>) =>
      this.egressFetch(cruxId, world.egress, String(url), init);
    const visitorId = input.visitorId;
    const writer = visitorId ?? crux.authorId;
    const isOwner = visitorId === crux.authorId;
    return Object.freeze({
      crux: { id: cruxId },
      visitor: visitorId ? { id: visitorId, isOwner } : null,
      owner: { id: crux.authorId },
      secrets: Object.freeze({
        get: (name: string) => world.secrets.get(String(name)) ?? null,
        has: (name: string) => world.secrets.has(String(name)),
      }),
      fetch: fetchOut,
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
      json: (value: unknown, status = 200) => ({
        __json: value,
        __status: status,
      }),
      text: (
        body: unknown,
        status = 200,
        type = 'text/plain; charset=utf-8',
      ) => ({
        __text: String(body ?? ''),
        __status: status,
        __type: type,
      }),
      html: (body: unknown, status = 200) => ({
        __text: String(body ?? ''),
        __status: status,
        __type: 'text/html; charset=utf-8',
      }),
      redirect: (url: string, status = 302) => ({
        __text: '',
        __status: status,
        __headers: { Location: String(url) },
      }),
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
        increment: async (
          key: string,
          by = 1,
          mode: 'public' | 'protected' = 'public',
        ) =>
          this.store.increment(
            cruxId,
            crux.authorId,
            String(key),
            Number(by) || 1,
            writer,
            mode,
          ),
        list: async (prefix = '') =>
          (await this.store.list(cruxId))
            .filter((e) => e.key.startsWith(String(prefix)))
            .map((e) => ({ key: e.key, value: e.value, mode: e.mode })),
        del: async (key: string) => this.store.delete(cruxId, String(key)),
      }),
    });
  }
}

/** What a handler returned, as an HTTP answer: ctx.json / ctx.text / ctx.html / ctx.redirect, or a plain value as JSON. */
function answerOf(outcome: unknown): {
  status: number;
  body: unknown;
  contentType?: string;
  headers?: Record<string, string>;
} {
  if (outcome && typeof outcome === 'object') {
    const o = outcome as Record<string, unknown>;
    if ('__text' in o)
      return {
        status: Number(o.__status) || 200,
        body: o.__text,
        contentType:
          typeof o.__type === 'string' ? o.__type : 'text/plain; charset=utf-8',
        headers: (o.__headers as Record<string, string>) ?? {},
      };
    if ('__json' in o)
      return { status: Number(o.__status) || 200, body: o.__json };
  }
  return { status: 200, body: outcome ?? null };
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
