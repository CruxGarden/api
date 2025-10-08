import { Injectable, OnModuleDestroy } from '@nestjs/common';
// import { Knex, knex } from 'knex';
import knex, { Knex } from 'knex';
import knexConfig from '../../../knexfile';
import { attachPaginate } from 'knex-paginate';
import { URL } from 'url';
import { Request, Response } from 'express';
import * as formatLink from 'format-link-header';

attachPaginate();

export interface PaginationOptions<TRaw = any, TModel = any> {
  model?: new (data: TRaw) => TModel;
  query: Knex.QueryBuilder<TRaw, TRaw[]>;
  request: Request;
  response: Response;
}

@Injectable()
export class DbService implements OnModuleDestroy {
  private client: Knex;

  constructor() {
    const config =
      process.env.NODE_ENV === 'production'
        ? knexConfig.production
        : knexConfig.development;

    this.client = knex(config);
  }

  query(): Knex {
    return this.client;
  }

  async paginate<TRaw = any, TModel = any>(
    opts: PaginationOptions<TRaw, TModel>,
  ): Promise<TModel[] | TRaw[]> {
    const pageDefault = 1;
    const perPageDefault = 25;
    const pageQueryName = 'page';
    const perPageQueryName = opts.request.query['perPage']
      ? 'perPage'
      : 'per_page';
    const linkHeaderName = 'Link';
    const paginationHeaderName = 'Pagination';

    const page = parseInt(opts.request.query[pageQueryName]?.toString(), 10);
    const perPage = parseInt(
      opts.request.query[perPageQueryName]?.toString(),
      10,
    );

    const r = await opts.query.paginate({
      perPage: perPage || perPageDefault,
      currentPage: page || pageDefault,
      isLengthAware: true,
    });

    const url = new URL(`${process.env.BASE_URL}${opts.request.originalUrl}`);
    if (perPage)
      url.searchParams.set(perPageQueryName, r.pagination.perPage.toString());

    const link: any = {};

    // first
    const firstPage = 1;
    url.searchParams.set(pageQueryName, firstPage.toString());
    link.first = {
      [pageQueryName]: firstPage,
      [perPageQueryName]: r.pagination.perPage,
      rel: 'first',
      url: url.toString(),
    };
    // ~first

    // prev
    let prevPage = r.pagination.currentPage - 1;
    if (prevPage < 1) prevPage = 1;
    url.searchParams.set(pageQueryName, prevPage.toString());
    link.prev = {
      [pageQueryName]: prevPage,
      [perPageQueryName]: r.pagination.perPage,
      rel: 'prev',
      url: url.toString(),
    };
    // ~prev

    // next
    let nextPage = r.pagination.currentPage + 1;
    if (nextPage > r.pagination.lastPage) nextPage = r.pagination.lastPage;
    url.searchParams.set(pageQueryName, nextPage.toString());
    link.next = {
      [pageQueryName]: nextPage,
      [perPageQueryName]: r.pagination.perPage,
      rel: 'next',
      url: url.toString(),
    };
    // ~next

    // last
    const lastPage = r.pagination.lastPage;
    url.searchParams.set(pageQueryName, lastPage.toString());
    link.last = {
      [pageQueryName]: lastPage,
      [perPageQueryName]: r.pagination.perPage,
      rel: 'last',
      url: url.toString(),
    };
    // ~last

    opts.response.setHeader(linkHeaderName, formatLink(link));
    opts.response.setHeader(
      paginationHeaderName,
      JSON.stringify({
        currentPage: r.pagination.currentPage,
        perPage: r.pagination.perPage,
        total: r.pagination.total,
      }),
    );

    return opts.model ? r.data.map((d: TRaw) => new opts.model!(d)) : r.data;
  }

  async onModuleDestroy() {
    await this.client.destroy();
  }
}
