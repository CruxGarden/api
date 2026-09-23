import { TaskMergeRepository } from './task-merge.repository';
import { TaskMergeService } from './task-merge.service';
import {
  captureCruxCreate,
  LocalCruxCreate,
  PrepareCruxFolder,
} from './crux-create';
import { CruxLifecycleRepository } from './crux-lifecycle.repository';
import { CruxLifecycleService } from './crux-lifecycle.service';
import { WorkingCopyRepository } from './working-copy.repository';
import { WorkingCopyService } from './working-copy.service';
import 'reflect-metadata';
import { DynamicModule, INestApplicationContext, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { isAbsolute, dirname, basename, join } from 'path';
import { realpath, stat, open as openFile } from 'fs/promises';
import {
  writeFileSync,
  renameSync,
  statSync,
  rmSync,
  openSync,
  fsyncSync,
  closeSync,
} from 'fs';
import { randomUUID } from 'crypto';
import { captureCruxUpdate, LocalCruxUpdate } from './crux-update';
import type { UpdateCruxDto } from '../crux/dto/update-crux.dto';
import type { DesktopContentStore } from './desktop-content';
import { inspectDesktopRecovery } from './desktop-recovery';
import { inspectDesktopFile } from './desktop-schema';
import { checkpointDesktopMigration } from './startup-recovery';
import { migrateDesktopDatabase } from './desktop-migration';
import { bootstrapDesktopDatabase } from './desktop-bootstrap';
import { AsyncLocalStorage } from 'async_hooks';
import { DbService } from '../common/services/db.service';
import { LoggerService } from '../common/services/logger.service';
import { KeyMaster } from '../common/services/key.master';
import { sqliteGraphConfig } from '../common/database/sqlite-graph';
import { CruxGraphService } from '../crux/crux-graph.service';
import { CruxRepository } from '../crux/crux.repository';
import { DimensionService } from '../dimension/dimension.service';
import { DimensionRepository } from '../dimension/dimension.repository';
import { GardenMembershipRepository } from './garden-membership.repository';
import {
  GardenMembershipService,
  AddGardenMember,
} from './garden-membership.service';

// A failed close leaves connection ownership uncertain: never admit another owner.
class DatabaseShutdownError extends AggregateError {}

@Module({})
class LocalGraphModule {
  static register(database: DbService, logger: LoggerService): DynamicModule {
    return {
      module: LocalGraphModule,
      providers: [
        { provide: DbService, useValue: database },
        { provide: LoggerService, useValue: logger },
        KeyMaster,
        CruxGraphService,
        CruxRepository,
        DimensionService,
        DimensionRepository,
        GardenMembershipRepository,
        GardenMembershipService,
        WorkingCopyRepository,
        WorkingCopyService,
        CruxLifecycleRepository,
        CruxLifecycleService,
        TaskMergeRepository,
        TaskMergeService,
      ],
    };
  }
}

export interface GraphOperations {
  crux: CruxGraphService;
  dimension: DimensionService;
  garden: GardenMembershipService;
  workingCopy: WorkingCopyService;
  lifecycle: CruxLifecycleService;
  taskMerge: TaskMergeService;
}

/** Ephemeral invalidation for named commands, never a content payload or durable log.
 * Compatibility SQL and arbitrary execute callbacks do not produce notifications. */
export interface LocalGraphChange {
  readonly streamId: string;
  readonly sequence: number;
  readonly entity:
    | 'crux'
    | 'working-copy'
    | 'garden-membership'
    | 'database'
    | 'crux-lifecycle';
  readonly operation?: 'create' | 'purge' | 'trash' | 'restore';
  readonly id?: string;
  readonly cruxId?: string;
  readonly fields?: readonly string[];
  readonly metaKeys?: readonly string[];
}
type ChangeDetail = Omit<LocalGraphChange, 'streamId' | 'sequence'>;
type ChangeListener = (change: LocalGraphChange) => void | Promise<void>;

/**
 * One local API owner over one existing desktop database. No hosted AppModule,
 * HTTP listener, renderer backend switch or credentials are started here.
 *
 * Host-side entry only: execute callbacks and compatibility SQL must never be
 * exposed as arbitrary remote input. A transport maps authorized named tools
 * to these operations. Callbacks must await all work and not retain providers.
 */
export class LocalGraphRuntime {
  // Host-process admission, not an OS lock. Every app writer must still use
  // this runtime; an unrelated process/SQLite client is outside this guard.
  private static readonly ownedFiles = new Set<string>();
  private pending: Promise<void> = Promise.resolve();
  private closing: Promise<void> | null = null;
  private recoveryClosing: Promise<ArrayBuffer> | null = null;
  private readonly commandScope = new AsyncLocalStorage<boolean>();
  private readonly streamId = randomUUID();
  private sequence = 0;
  private readonly listeners = new Set<ChangeListener>();
  private replacing = false;
  private failure: Error | null = null;
  private db: DbService;
  private operations: GraphOperations;

  private constructor(
    private context: INestApplicationContext,
    private readonly ownershipKeys: string[],
    private readonly filename: string,
  ) {
    this.bind(context);
  }

  private bind(context: INestApplicationContext): void {
    this.context = context;
    this.db = context.get(DbService);
    this.operations = Object.freeze({
      crux: context.get(CruxGraphService),
      dimension: context.get(DimensionService),
      garden: context.get(GardenMembershipService),
      workingCopy: context.get(WorkingCopyService),
      lifecycle: context.get(CruxLifecycleService),
      taskMerge: context.get(TaskMergeService),
    });
  }

  static open(
    filename: string,
    options?: { contentStore: DesktopContentStore },
  ): Promise<LocalGraphRuntime> {
    return this.start(filename, false, options?.contentStore);
  }

  /** Explicit fresh-file creation; never overwrites or bootstraps an existing file. */
  static create(filename: string): Promise<LocalGraphRuntime> {
    return this.start(filename, true);
  }

  private static async start(
    filename: string,
    create: boolean,
    contentStore?: DesktopContentStore,
  ): Promise<LocalGraphRuntime> {
    if (!isAbsolute(filename)) {
      throw new Error('Local API requires an absolute database file');
    }
    const canonical = create
      ? join(await realpath(dirname(filename)), basename(filename))
      : await realpath(filename);
    const ownershipKeys = [`path:${canonical}`];
    if (!create) {
      const file = await stat(canonical, { bigint: true });
      if (!file.isFile())
        throw new Error(
          'Local API requires an existing absolute database file',
        );
      ownershipKeys.push(`file:${file.dev}:${file.ino}`);
    }
    // Reserve canonical location before creating/opening. Existing files also
    // reserve inode identity, so symlink/hard-link aliases cannot gain an owner.
    if (ownershipKeys.some((key) => this.ownedFiles.has(key))) {
      throw new Error('Local API database is already owned in this process');
    }
    ownershipKeys.forEach((key) => this.ownedFiles.add(key));
    try {
      if (create) {
        const file = await openFile(canonical, 'wx', 0o600);
        try {
          const identity = await file.stat({ bigint: true });
          const key = `file:${identity.dev}:${identity.ino}`;
          ownershipKeys.push(key);
          this.ownedFiles.add(key);
        } finally {
          await file.close();
        }
      }
      if (!create) checkpointDesktopMigration(canonical, !!contentStore);
      const context = await this.openContext(canonical, create, contentStore);
      return new LocalGraphRuntime(context, ownershipKeys, canonical);
    } catch (error) {
      if (!(error instanceof DatabaseShutdownError))
        ownershipKeys.forEach((key) => this.ownedFiles.delete(key));
      throw error;
    }
  }

  private static async openContext(
    filename: string,
    create = false,
    contentStore?: DesktopContentStore,
  ): Promise<INestApplicationContext> {
    if (!create) inspectDesktopFile(filename, !!contentStore);
    const logger = new LoggerService();
    const database = new DbService(logger, sqliteGraphConfig(filename));
    let context: INestApplicationContext | undefined;
    try {
      context = await NestFactory.createApplicationContext(
        LocalGraphModule.register(database, logger),
        { logger: false, abortOnError: false },
      );
      if (create) await bootstrapDesktopDatabase(database.query());
      else await migrateDesktopDatabase(database.query(), contentStore);
      return context;
    } catch (error) {
      try {
        if (context) await context.close();
        else await database.onModuleDestroy();
      } catch (shutdown) {
        throw new DatabaseShutdownError(
          [error, shutdown],
          'Local API failed to close after startup failure',
        );
      }
      throw error;
    }
  }

  private admissionError(): Error | null {
    if (this.commandScope.getStore())
      return new Error('Nested local API commands are not allowed');
    if (this.failure) return this.failure;
    if (this.closing) return new Error('Local API is closing');
    if (this.replacing) return new Error('Local API is replacing its database');
    return null;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const refused = this.admissionError();
    if (refused) return Promise.reject(refused);
    const result = this.pending.then(() =>
      this.commandScope.run(true, operation),
    );
    // One failed command must not poison later commands or shutdown.
    this.pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Serialize a complete command and commit all its repository writes together. */
  execute<T>(operation: (services: GraphOperations) => Promise<T>): Promise<T> {
    return this.enqueue(() =>
      this.db.transaction(() => operation(this.operations)),
    );
  }

  onChange(listener: ChangeListener): () => void {
    const refused = this.admissionError();
    if (refused) throw refused;
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(detail: ChangeDetail): void {
    const change: LocalGraphChange = Object.freeze({
      ...detail,
      ...(detail.fields ? { fields: Object.freeze([...detail.fields]) } : {}),
      ...(detail.metaKeys
        ? { metaKeys: Object.freeze([...detail.metaKeys]) }
        : {}),
      streamId: this.streamId,
      sequence: ++this.sequence,
    });
    // Subscribers may enqueue reads after commit. Never await them inside the
    // owner queue, and never let a broken observer turn a committed save into failure.
    this.commandScope.exit(() => {
      for (const listener of [...this.listeners]) {
        try {
          Promise.resolve(listener(change)).catch(() => {});
        } catch {
          /* observer only */
        }
      }
    });
  }

  private executeChanged<T>(
    operation: (services: GraphOperations) => Promise<T>,
    change: (result: T) => ChangeDetail,
  ): Promise<T> {
    return this.enqueue(async () => {
      const result = await this.db.transaction(() =>
        operation(this.operations),
      );
      this.notify(change(result));
      return result;
    });
  }

  /** Capture a complete detail patch, then read/merge/write in one transaction. */
  async updateCrux(id: string, patch: LocalCruxUpdate): Promise<void> {
    if (typeof id !== 'string' || !id) throw new Error('Use a Crux identity');
    const captured = captureCruxUpdate(patch);
    await this.executeChanged(
      async ({ crux }) => {
        const current = await crux.findById(id);
        // Enum strings were checked at admission. The desktop-only remoteId is
        // retained by the repository; it is never added to the hosted HTTP DTO.
        await crux.update(id, {
          ...captured,
          ...(captured.meta === undefined
            ? {}
            : { meta: { ...current.meta, ...captured.meta } }),
        } as UpdateCruxDto);
      },
      () => ({
        entity: 'crux',
        id,
        fields: Object.keys(captured),
        metaKeys: Object.keys(captured.meta ?? {}),
      }),
    );
  }

  /** Compatibility for hosts that adopted metadata commands first. */
  async mergeCruxMeta(
    id: string,
    patch: Record<string, unknown>,
  ): Promise<void> {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch))
      throw new Error('Use a metadata object');
    return this.updateCrux(id, { meta: patch });
  }

  /** Merge Task descriptive state without giving metadata control of its identity or folder. */
  async updateWorkingCopyMeta(
    id: string,
    patch: Record<string, unknown>,
    title?: string,
  ): Promise<void> {
    if (
      typeof id !== 'string' ||
      !id ||
      !patch ||
      typeof patch !== 'object' ||
      Array.isArray(patch)
    )
      throw new Error('Use a Working Copy identity and metadata object');
    const captured = captureCruxUpdate({ meta: patch, title });
    await this.executeChanged(
      ({ workingCopy }) =>
        workingCopy.updateMeta(id, captured.meta!, captured.title),
      (cruxId) => ({
        entity: 'working-copy',
        id,
        cruxId,
        fields: Object.keys(captured),
        metaKeys: Object.keys(captured.meta!),
      }),
    );
  }

  async saveTaskReview(
    reviewData: string,
    expectedData?: string,
  ): Promise<void> {
    if (
      typeof reviewData !== 'string' ||
      (expectedData !== undefined && typeof expectedData !== 'string')
    )
      throw new Error('Use serialized review data');
    const next = JSON.parse(reviewData);
    const expected =
      expectedData === undefined ? undefined : JSON.parse(expectedData);
    await this.executeChanged(
      ({ taskMerge }) => taskMerge.save(next, expected),
      (copy) => ({ entity: 'working-copy', ...copy, fields: ['phase'] }),
    );
  }

  async beginTaskMerge(id: string, reviewData: string): Promise<void> {
    if (typeof id !== 'string' || !id || typeof reviewData !== 'string')
      throw new Error('Use a review identity and its checked journal');
    // Strings capture the exact reviewed input before waiting for API ownership.
    const captured = JSON.parse(reviewData);
    await this.executeChanged(
      ({ taskMerge }) => taskMerge.begin(id, captured),
      (copy) => ({ entity: 'working-copy', ...copy, fields: ['phase'] }),
    );
  }

  async releaseTaskReview(id: string): Promise<void> {
    if (typeof id !== 'string' || !id) throw new Error('Use a review identity');
    await this.executeChanged(
      ({ taskMerge }) => taskMerge.release(id),
      (copy) => ({ entity: 'working-copy', ...copy, fields: ['phase'] }),
    );
  }

  async completeTaskMerge(id: string, resultHead: string): Promise<void> {
    if (
      typeof id !== 'string' ||
      !id ||
      typeof resultHead !== 'string' ||
      !resultHead
    )
      throw new Error('Use a merge identity and result snapshot');
    await this.executeChanged(
      ({ taskMerge }) => taskMerge.complete(id, resultHead),
      (copy) => ({ entity: 'working-copy', ...copy, fields: ['phase'] }),
    );
  }

  async setWorkingCopyArchived(
    id: string,
    archived: boolean,
    revision: number,
  ): Promise<void> {
    if (
      typeof id !== 'string' ||
      !id ||
      typeof archived !== 'boolean' ||
      !Number.isSafeInteger(revision) ||
      revision < 0 ||
      revision >= Number.MAX_SAFE_INTEGER
    )
      throw new Error('Use a Task identity, archive state and valid revision');
    await this.executeChanged(
      ({ workingCopy }) => workingCopy.setArchived(id, archived, revision),
      (cruxId) => ({ entity: 'working-copy', id, cruxId, fields: ['phase'] }),
    );
  }

  async createCrux(
    input: LocalCruxCreate,
    prepareFolder?: PrepareCruxFolder,
  ): Promise<string> {
    const captured = captureCruxCreate(input);
    return this.executeChanged(
      ({ lifecycle }) => lifecycle.create(captured, prepareFolder),
      (id) => ({ entity: 'crux-lifecycle', operation: 'create', id }),
    );
  }

  async setCruxTrashed(id: string, trashed: boolean): Promise<void> {
    if (typeof id !== 'string' || !id || typeof trashed !== 'boolean')
      throw new Error('Use a Crux identity and trash state');
    await this.executeChanged(
      ({ lifecycle }) => lifecycle.setTrashed(id, trashed),
      () => ({
        entity: 'crux-lifecycle',
        operation: trashed ? 'trash' : 'restore',
        id,
      }),
    );
  }

  async deleteCrux(id: string): Promise<void> {
    if (typeof id !== 'string' || !id) throw new Error('Use a Crux identity');
    await this.executeChanged(
      ({ lifecycle }) => lifecycle.purge(id),
      () => ({ entity: 'crux-lifecycle', operation: 'purge', id }),
    );
  }

  addGardenMember(input: AddGardenMember) {
    const captured = { ...input };
    return this.executeChanged(
      ({ garden }) => garden.add(captured),
      () => ({
        entity: 'garden-membership',
        id: captured.gardenId,
        cruxId: captured.memberId,
      }),
    );
  }

  removeGardenMember(gardenId: string, memberId: string) {
    return this.executeChanged(
      ({ garden }) => garden.remove(gardenId, memberId),
      () => ({ entity: 'garden-membership', id: gardenId, cruxId: memberId }),
    );
  }

  listGardenMembers(
    gardenId: string,
    options?: { limit?: number; after?: string },
  ) {
    const captured = { ...options };
    return this.execute(({ garden }) => garden.list(gardenId, captured));
  }

  private async withConnection<T>(
    operation: (connection: any) => T,
  ): Promise<T> {
    const client = this.db.query().client;
    const connection = await client.acquireConnection();
    try {
      return operation(connection);
    } finally {
      await client.releaseConnection(connection);
    }
  }

  /** Temporary internal bridge for legacy callers; preserve native row shapes. */
  private async legacy<T>(
    sql: string,
    params: unknown[],
    method: 'run' | 'get' | 'all',
  ): Promise<T> {
    const statement = sql.replace(
      /^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/,
      '',
    );
    if (
      /^(?:BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE|ATTACH|DETACH)\b/i.test(
        statement,
      )
    ) {
      return Promise.reject(
        new Error(
          'Use an owned API transaction; legacy SQL cannot change connection ownership',
        ),
      );
    }
    // Capture at admission: callers may reuse arrays or change nested state
    // while a previous command is still running. Keep native row conventions.
    const bindings = params.map((value) => {
      if (value === undefined) return null;
      if (typeof value === 'boolean') return Number(value);
      if (Buffer.isBuffer(value)) return Buffer.from(value);
      if (value !== null && typeof value === 'object') {
        return JSON.stringify(value);
      }
      return value;
    });
    return this.enqueue(() =>
      this.withConnection((connection) => {
        const result = connection.prepare(sql)[method](...bindings);
        return (method === 'run' ? { changes: result.changes } : result) as T;
      }),
    );
  }

  run(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
    return this.legacy(sql, params, 'run');
  }

  get<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T | undefined> {
    return this.legacy(sql, params, 'get');
  }

  all<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    return this.legacy(sql, params, 'all');
  }

  /** Whole-installation database image; never a selected Garden share format. */
  exportDatabase(): Promise<ArrayBuffer> {
    return this.enqueue(() =>
      this.withConnection((connection) => {
        const bytes: Buffer = connection.serialize();
        return bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ) as ArrayBuffer;
      }),
    );
  }

  /**
   * Host-internal whole-installation replacement. The host must stage/verify
   * content and quiesce its writers first. Returns the previous image, captured
   * after every admitted command, for rollback of subsequent host-level work.
   * Ownership stays reserved through preparation, close, rename and reopen.
   */
  replaceDatabase(data: ArrayBuffer): Promise<ArrayBuffer> {
    const refused = this.admissionError();
    if (refused) return Promise.reject(refused);
    let captured: ArrayBuffer;
    try {
      captured = inspectDesktopRecovery(data).database;
    } catch (error) {
      return Promise.reject(error);
    }
    const replacement = this.enqueue(() =>
      this.replaceCapturedDatabase(captured),
    );
    this.replacing = true;
    return replacement.then(
      (previous) => {
        this.replacing = false;
        this.notify({ entity: 'database' });
        return previous;
      },
      (error) => {
        this.replacing = false;
        throw error;
      },
    );
  }

  private reserveCurrentIdentity(): void {
    // No await between rename and reserving the new inode: hard-link aliases
    // cannot acquire ownership while a replacement context is opening.
    const file = statSync(this.filename, { bigint: true });
    const key = `file:${file.dev}:${file.ino}`;
    if (!this.ownershipKeys.includes(key)) {
      this.ownershipKeys.push(key);
      LocalGraphRuntime.ownedFiles.add(key);
    }
  }

  private async replaceCapturedDatabase(
    data: ArrayBuffer,
  ): Promise<ArrayBuffer> {
    const prefix = join(
      dirname(this.filename),
      `.${basename(this.filename)}.${randomUUID()}`,
    );
    const candidatePath = `${prefix}.restore`;
    const recoveryPath = `${prefix}.recovery`;
    let candidate: INestApplicationContext | undefined;
    let candidateClosed = false;
    let closingStarted = false;
    let closed = false;
    let swapped = false;
    let retainFiles = false;
    try {
      writeFileSync(candidatePath, Buffer.from(data), {
        flag: 'wx',
        mode: 0o600,
        flush: true,
      });
      // Prepare the complete incoming file through the same API adapter before
      // touching the working connection. Unknown tables/columns remain intact.
      candidate = await LocalGraphRuntime.openContext(candidatePath);
      await candidate.close();
      candidateClosed = true;
      const staged = openSync(candidatePath, 'r+');
      try {
        fsyncSync(staged);
      } finally {
        closeSync(staged);
      }
      const previous = await this.withConnection(
        (connection) => Uint8Array.from(connection.serialize()).buffer,
      );
      const recovery = inspectDesktopRecovery(previous).database;
      writeFileSync(recoveryPath, Buffer.from(recovery), {
        flag: 'wx',
        mode: 0o600,
        flush: true,
      });
      closingStarted = true;
      await this.context.close();
      closed = true;
      renameSync(candidatePath, this.filename);
      swapped = true;
      this.reserveCurrentIdentity();
      this.bind(await LocalGraphRuntime.openContext(this.filename));
      return previous;
    } catch (error) {
      // Never reopen across a connection whose shutdown is uncertain.
      if (
        (closingStarted && !closed) ||
        error instanceof DatabaseShutdownError
      ) {
        retainFiles = true;
        this.failure = new AggregateError(
          [error],
          `Local API recovery required; retained files at ${prefix}`,
        );
        throw this.failure;
      }
      if (closed) {
        try {
          if (swapped) {
            renameSync(recoveryPath, this.filename);
            this.reserveCurrentIdentity();
          }
          this.bind(await LocalGraphRuntime.openContext(this.filename));
        } catch (rollback) {
          retainFiles = true;
          this.failure = new AggregateError(
            [error, rollback],
            `Local API recovery required; retained files at ${prefix}`,
          );
          throw this.failure;
        }
      }
      throw error;
    } finally {
      if (candidate && !candidateClosed) retainFiles = true;
      if (!retainFiles) {
        for (const file of [candidatePath, recoveryPath]) {
          try {
            rmSync(file, { force: true });
          } catch {
            /* orphan cleanup is separate */
          }
        }
      }
    }
  }

  /**
   * Close this owner with a final recovery image containing every admitted write.
   * New commands are refused immediately. Even if serialization fails, shutdown
   * drains and closes before rejecting; the existing file can be reopened.
   * Host-internal full-installation recovery, never a selected Garden export.
   */
  closeWithRecoveryImage(): Promise<ArrayBuffer> {
    if (this.commandScope.getStore())
      return Promise.reject(
        new Error('Cannot close the local API within a command'),
      );
    if (this.recoveryClosing) return this.recoveryClosing;
    if (this.closing) return Promise.reject(new Error('Local API is closing'));
    const refused = this.admissionError();
    if (refused) return Promise.reject(refused);
    const image = this.exportDatabase();
    const closed = this.close();
    this.recoveryClosing = Promise.allSettled([image, closed]).then(
      ([snapshot, shutdown]) => {
        if (snapshot.status === 'rejected' && shutdown.status === 'rejected')
          throw new AggregateError(
            [snapshot.reason, shutdown.reason],
            'Recovery export and local API shutdown failed',
          );
        if (snapshot.status === 'rejected') throw snapshot.reason;
        if (shutdown.status === 'rejected') throw shutdown.reason;
        return snapshot.value;
      },
    );
    return this.recoveryClosing;
  }

  /** Stop admission immediately, drain admitted operations, then close SQLite. */
  close(): Promise<void> {
    if (this.commandScope.getStore()) {
      return Promise.reject(
        new Error('Cannot close the local API within a command'),
      );
    }
    this.closing ??= this.pending.then(async () => {
      if (this.failure) throw this.failure;
      await this.context.close();
      this.listeners.clear();
      // Release only after SQLite is closed; failed shutdown must not admit
      // another owner over a potentially live connection.
      this.ownershipKeys.forEach((key) =>
        LocalGraphRuntime.ownedFiles.delete(key),
      );
    });
    return this.closing;
  }
}
