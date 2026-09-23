import 'reflect-metadata';
import { DynamicModule, INestApplicationContext, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { isAbsolute } from 'path';
import { realpath, stat } from 'fs/promises';
import { AsyncLocalStorage } from 'async_hooks';
import { DbService } from '../common/services/db.service';
import { LoggerService } from '../common/services/logger.service';
import { KeyMaster } from '../common/services/key.master';
import {
  sqliteGraphConfig,
  prepareDesktopGraph,
} from '../common/database/sqlite-graph';
import { CruxGraphService } from '../crux/crux-graph.service';
import { CruxRepository } from '../crux/crux.repository';
import { DimensionService } from '../dimension/dimension.service';
import { DimensionRepository } from '../dimension/dimension.repository';
import { GardenMembershipRepository } from './garden-membership.repository';
import {
  GardenMembershipService,
  AddGardenMember,
} from './garden-membership.service';

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
      ],
    };
  }
}

export interface GraphOperations {
  crux: CruxGraphService;
  dimension: DimensionService;
  garden: GardenMembershipService;
}

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
  private readonly commandScope = new AsyncLocalStorage<boolean>();
  private readonly db: DbService;
  private readonly operations: GraphOperations;

  private constructor(
    private readonly context: INestApplicationContext,
    private readonly ownershipKeys: string[],
  ) {
    this.db = context.get(DbService);
    this.operations = Object.freeze({
      crux: context.get(CruxGraphService),
      dimension: context.get(DimensionService),
      garden: context.get(GardenMembershipService),
    });
  }

  static async open(filename: string): Promise<LocalGraphRuntime> {
    if (!isAbsolute(filename)) {
      throw new Error('Local API requires an existing absolute database file');
    }
    const canonical = await realpath(filename);
    const file = await stat(canonical, { bigint: true });
    if (!file.isFile()) {
      throw new Error('Local API requires an existing absolute database file');
    }
    // Canonical path catches symlinks and reopens while draining; file identity
    // also catches hard links. Reserve synchronously before any startup await.
    const ownershipKeys = [`path:${canonical}`, `file:${file.dev}:${file.ino}`];
    if (ownershipKeys.some((key) => this.ownedFiles.has(key))) {
      throw new Error('Local API database is already owned in this process');
    }
    ownershipKeys.forEach((key) => this.ownedFiles.add(key));
    let database: DbService | undefined;
    let context: INestApplicationContext | undefined;
    try {
      const logger = new LoggerService();
      database = new DbService(logger, sqliteGraphConfig(canonical));
      context = await NestFactory.createApplicationContext(
        LocalGraphModule.register(database, logger),
        { logger: false, abortOnError: false },
      );
      await prepareDesktopGraph(database.query());
      return new LocalGraphRuntime(context, ownershipKeys);
    } catch (error) {
      if (context) await context.close();
      else await database?.onModuleDestroy();
      ownershipKeys.forEach((key) => this.ownedFiles.delete(key));
      throw error;
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.commandScope.getStore()) {
      return Promise.reject(
        new Error('Nested local API commands are not allowed'),
      );
    }
    if (this.closing) return Promise.reject(new Error('Local API is closing'));
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

  addGardenMember(input: AddGardenMember) {
    const captured = { ...input };
    return this.execute(({ garden }) => garden.add(captured));
  }

  removeGardenMember(gardenId: string, memberId: string) {
    return this.execute(({ garden }) => garden.remove(gardenId, memberId));
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

  /** Stop admission immediately, drain admitted operations, then close SQLite. */
  close(): Promise<void> {
    if (this.commandScope.getStore()) {
      return Promise.reject(
        new Error('Cannot close the local API within a command'),
      );
    }
    this.closing ??= this.pending.then(async () => {
      await this.context.close();
      // Release only after SQLite is closed; failed shutdown must not admit
      // another owner over a potentially live connection.
      this.ownershipKeys.forEach((key) =>
        LocalGraphRuntime.ownedFiles.delete(key),
      );
    });
    return this.closing;
  }
}
