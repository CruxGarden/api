import { Injectable } from '@nestjs/common';
import { Knex } from 'knex';
import { DbService } from '../common/services/db.service';
import { LoggerService } from '../common/services/logger.service';

export type ExploreSort = 'recent' | 'newest' | 'alpha';

export interface ExploreCruxFilters {
  q?: string;
  tag?: string[];
  /** Crux kind (webapp, page, document, image, notes, mood) */
  kind?: string;
  /** Author username (exact, case-insensitive) */
  author?: string;
  sort?: ExploreSort;
}

export interface ExploreAuthorFilters {
  q?: string;
  sort?: ExploreSort;
}

@Injectable()
export class ExploreRepository {
  // @ts-expect-error - logger
  private readonly logger: LoggerService;

  constructor(
    private readonly dbService: DbService,
    private readonly loggerService: LoggerService,
  ) {
    this.logger = this.loggerService.createChildLogger('ExploreRepository');
  }

  /**
   * Query discoverable, public, non-deleted cruxes.
   * Joins author for username/displayName.
   * Optionally filters by text search and/or tags.
   */
  findCruxesQuery(filters: ExploreCruxFilters): Knex.QueryBuilder {
    const query = this.dbService
      .query()
      .from('cruxes as c')
      .select(
        'c.id',
        'c.slug',
        'c.title',
        'c.description',
        'c.kind',
        'c.meta',
        'c.created',
        'c.updated',
        'a.username as author_username',
        'a.display_name as author_display_name',
        'a.meta as author_meta',
        // The crux's tags, so a result card can show them without N more requests
        this.dbService
          .query()
          .raw(
            `(SELECT COALESCE(array_agg(t.label ORDER BY t.label), '{}') FROM tags t WHERE t.resource_id = c.id AND t.resource_type = 'crux' AND t.deleted IS NULL) as tags`,
          ),
      )
      .join('authors as a', 'a.id', 'c.author_id')
      .where('c.visibility', 'public')
      .where('c.discoverable', true)
      .whereNull('c.deleted')
      .whereNull('a.deleted');

    if (filters.q) {
      const term = `%${filters.q}%`;
      query.where(function () {
        this.where('c.title', 'ilike', term)
          .orWhere('c.description', 'ilike', term)
          .orWhere('c.slug', 'ilike', term)
          .orWhere('a.username', 'ilike', term)
          .orWhereExists(function () {
            this.select('*')
              .from('tags as t')
              .whereRaw('t.resource_id = c.id')
              .where('t.resource_type', 'crux')
              .where('t.label', 'ilike', term)
              .whereNull('t.deleted');
          });
      });
    }

    if (filters.kind) {
      query.where('c.kind', filters.kind);
    }

    if (filters.author) {
      query.whereRaw('lower(a.username) = ?', [filters.author.toLowerCase()]);
    }

    if (filters.tag && filters.tag.length > 0) {
      for (const tag of filters.tag) {
        query.whereExists(function () {
          this.select('*')
            .from('tags as t')
            .whereRaw('t.resource_id = c.id')
            .where('t.resource_type', 'crux')
            .where('t.label', tag.toLowerCase())
            .whereNull('t.deleted');
        });
      }
    }

    if (filters.sort === 'alpha') {
      query.orderBy('c.title', 'asc');
    } else if (filters.sort === 'newest') {
      query.orderBy('c.created', 'desc');
    } else {
      query.orderBy('c.updated', 'desc');
    }

    return query;
  }

  /**
   * Query authors who have at least one discoverable published crux.
   */
  findAuthorsQuery(filters: ExploreAuthorFilters): Knex.QueryBuilder {
    const query = this.dbService
      .query()
      .from('authors as a')
      .select(
        'a.id',
        'a.username',
        'a.display_name',
        'a.bio',
        'a.meta',
        'a.created',
      )
      .whereNull('a.deleted')
      .whereExists(function () {
        this.select('*')
          .from('cruxes as c')
          .whereRaw('c.author_id = a.id')
          .where('c.visibility', 'public')
          .where('c.discoverable', true)
          .whereNull('c.deleted');
      });

    if (filters.q) {
      const term = `%${filters.q}%`;
      query.where(function () {
        this.where('a.username', 'ilike', term).orWhere(
          'a.display_name',
          'ilike',
          term,
        );
      });
    }

    if (filters.sort === 'alpha') {
      query.orderBy('a.username', 'asc');
    } else {
      query.orderBy('a.created', 'desc');
    }

    return query;
  }

  /**
   * Popular tags across discoverable cruxes, with counts.
   */
  async findPopularTags(
    limit: number = 50,
    kind?: string,
  ): Promise<{ label: string; count: number }[]> {
    const query = this.dbService
      .query()
      .from('tags as t')
      .select('t.label')
      .count('* as count')
      .join('cruxes as c', 'c.id', 't.resource_id')
      .where('t.resource_type', 'crux')
      .where('c.visibility', 'public')
      .where('c.discoverable', true)
      .whereNull('c.deleted')
      .whereNull('t.deleted');
    if (kind) query.where('c.kind', kind);
    const rows = await query
      .groupBy('t.label')
      .orderBy('count', 'desc')
      .orderBy('t.label', 'asc')
      .limit(limit);

    return rows.map((r: any) => ({ label: r.label, count: Number(r.count) }));
  }
}
