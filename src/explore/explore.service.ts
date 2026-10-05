import { Injectable } from '@nestjs/common';
import { Knex } from 'knex';
import { LoggerService } from '../common/services/logger.service';
import { webOrigin } from '../common/helpers/web-origin';
import { buildSitemap, SitemapRow, SITEMAP_MAX_URLS } from './sitemap';
import {
  ExploreRepository,
  ExploreCruxFilters,
  ExploreAuthorFilters,
} from './explore.repository';

@Injectable()
export class ExploreService {
  // @ts-expect-error - logger
  private readonly logger: LoggerService;

  constructor(
    private readonly exploreRepository: ExploreRepository,
    private readonly loggerService: LoggerService,
  ) {
    this.logger = this.loggerService.createChildLogger('ExploreService');
  }

  getCruxesQuery(filters: ExploreCruxFilters): Knex.QueryBuilder {
    return this.exploreRepository.findCruxesQuery(filters);
  }

  getAuthorsQuery(filters: ExploreAuthorFilters): Knex.QueryBuilder {
    return this.exploreRepository.findAuthorsQuery(filters);
  }

  async getPopularTags(limit?: number, kind?: string) {
    return this.exploreRepository.findPopularTags(limit, kind);
  }

  /** Author pages and crux pages on the public website, capped at the protocol's limit. */
  async getSitemap(): Promise<string> {
    const rows: SitemapRow[] =
      await this.exploreRepository.findSitemapQuery(SITEMAP_MAX_URLS);
    return buildSitemap(webOrigin(), rows);
  }
}
