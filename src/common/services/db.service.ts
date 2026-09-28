import {
  BadRequestException,
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import knex, { Knex } from 'knex';
import { attachPaginate } from 'knex-paginate';
import { URL } from 'url';
import { Request, Response } from 'express';
import * as formatLink from 'format-link-header';
import { LoggerService } from './logger.service';
import { toEntityFields } from '../helpers/case-helpers';
import { AsyncLocalStorage } from 'async_hooks';
import { positiveIntegerQuery } from '../validation/positive-integer-query';

attachPaginate();

/** A deployment supplies its database; repositories keep the same contract. */
export const DATABASE_CONFIG = Symbol('DATABASE_CONFIG');

export interface PaginationOptions<TRaw = any, TModel = any> {
  model?: new (data: TRaw) => TModel;
  query: Knex.QueryBuilder<TRaw, TRaw[]>;
  request: Request;
  response: Response;
}

@Injectable()
export class DbService implements OnModuleInit, OnModuleDestroy {
  private client: Knex;
  private readonly logger: LoggerService;
  private hasLoggedConnectionError = false;
  private readonly transactionScope = new AsyncLocalStorage<Knex.Transaction>();

  constructor(
    private readonly loggerService: LoggerService,
    @Optional() @Inject(DATABASE_CONFIG) databaseConfig?: Knex.Config,
  ) {
    this.logger = this.loggerService.createChildLogger('DbService');

    // Load hosted environment/config only when no deployment adapter is given.
    // A local API must not discover credentials from a developer's .env file.
    const config = databaseConfig ?? this.hostedConfig();

    // DATE columns (usage_daily.day, usage_periods.period_start…) are calendar
    // days in UTC. node-pg would turn them into local-midnight Date objects and
    // shift them across time zones; keep them as 'YYYY-MM-DD' strings.
    if (!databaseConfig) {
      const { types } = require('pg');
      types.setTypeParser(1082, (v: string) => v);
    }
    this.client = knex(config);

    // Set up connection pool event listeners
    const pool = (this.client.client as any).pool;
    if (pool) {
      pool.on('createSuccess', () => {
        this.logger.info('Database client connected');
      });
      pool.on('createFail', (err: Error) => {
        if (!this.hasLoggedConnectionError) {
          this.logger.error('Database client connection failed', err);
          this.hasLoggedConnectionError = true;
        }
      });
    }
  }

  private hostedConfig(): Knex.Config {
    const knexConfig = require('../../../knexfile').default;
    return process.env.NODE_ENV === 'production'
      ? knexConfig.production
      : knexConfig.development;
  }

  async onModuleInit() {
    try {
      // Test the connection
      await this.client.raw('SELECT 1');
      this.logger.debug('Database connection established');
    } catch (error) {
      this.logger.error('Failed to establish database connection', error);
      throw error;
    }
  }

  query(): Knex {
    return this.transactionScope.getStore() ?? this.client;
  }

  /** All repositories called by this operation use the same transaction. */
  async transaction<T>(operation: () => Promise<T>): Promise<T> {
    return this.query().transaction((trx) =>
      this.transactionScope.run(trx, operation),
    );
  }

  async paginate<TRaw = any, TModel = any>(
    opts: PaginationOptions<TRaw, TModel>,
  ): Promise<TModel[] | TRaw[]> {
    const perPageName =
      opts.request.query.perPage !== undefined ? 'perPage' : 'per_page';
    const currentPage = positiveIntegerQuery(
      opts.request.query.page,
      'page',
      1,
    );
    if (currentPage > 1_000_000)
      throw new BadRequestException('page must not exceed 1000000');
    const perPage = Math.min(
      100,
      positiveIntegerQuery(opts.request.query[perPageName], perPageName, 25),
    );
    const r = await opts.query.paginate({
      perPage,
      currentPage,
      isLengthAware: true,
    });
    const lastPage = Math.max(1, r.pagination.lastPage);
    const url = new URL(`${process.env.BASE_URL}${opts.request.originalUrl}`);
    url.searchParams.set(perPageName, String(perPage));
    const pages = {
      first: 1,
      prev: Math.max(1, Math.min(lastPage, currentPage - 1)),
      next: Math.min(lastPage, currentPage + 1),
      last: lastPage,
    };
    const links = Object.fromEntries(
      Object.entries(pages).map(([rel, page]) => {
        const target = new URL(url);
        target.searchParams.set('page', String(page));
        return [
          rel,
          {
            page: String(page),
            [perPageName]: String(perPage),
            rel,
            url: target.toString(),
          },
        ];
      }),
    );
    opts.response.setHeader('Link', formatLink(links));
    opts.response.setHeader(
      'Pagination',
      JSON.stringify({
        currentPage,
        perPage,
        total: r.pagination.total,
        lastPage,
      }),
    );

    return opts.model
      ? r.data.map((d: TRaw) => new opts.model!(toEntityFields(d) as any))
      : r.data;
  }

  async onModuleDestroy() {
    await this.client.destroy();
  }
}
