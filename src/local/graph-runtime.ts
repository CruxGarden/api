import 'reflect-metadata';
import { DynamicModule, INestApplicationContext, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { isAbsolute } from 'path';
import { stat } from 'fs/promises';
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
      ],
    };
  }
}

export interface GraphOperations {
  crux: CruxGraphService;
  dimension: DimensionService;
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
  private pending: Promise<void> = Promise.resolve();
  private closing: Promise<void> | null = null;
  private readonly commandScope = new AsyncLocalStorage<boolean>();
  private readonly db: DbService;
  private readonly operations: GraphOperations;

  private constructor(private readonly context: INestApplicationContext) {
    this.db = context.get(DbService);
    this.operations = Object.freeze({
      crux: context.get(CruxGraphService),
      dimension: context.get(DimensionService),
    });
  }

  static async open(filename: string): Promise<LocalGraphRuntime> {
    if (!isAbsolute(filename) || !(await stat(filename)).isFile()) {
      throw new Error('Local API requires an existing absolute database file');
    }
    const logger = new LoggerService();
    const database = new DbService(logger, sqliteGraphConfig(filename));
    let context: INestApplicationContext | undefined;
    try {
      context = await NestFactory.createApplicationContext(
        LocalGraphModule.register(database, logger),
        { logger: false, abortOnError: false },
      );
      await prepareDesktopGraph(database.query());
      return new LocalGraphRuntime(context);
    } catch (error) {
      if (context) await context.close();
      else await database.onModuleDestroy();
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
  private legacy<T>(
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
    return this.enqueue(() =>
      this.withConnection((connection) => {
        // Match the existing SqliteNative bridge, not the API row codecs. Legacy
        // callers still JSON.parse(meta) and expect ISO strings and integer flags.
        const bindings = params.map((value) => {
          if (value === undefined) return null;
          if (typeof value === 'boolean') return Number(value);
          if (
            value !== null &&
            typeof value === 'object' &&
            !Buffer.isBuffer(value)
          ) {
            return JSON.stringify(value);
          }
          return value;
        });
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
    this.closing ??= this.pending.then(() => this.context.close());
    return this.closing;
  }
}
