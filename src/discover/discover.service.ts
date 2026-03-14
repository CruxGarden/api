import { Injectable } from '@nestjs/common';
import { Knex } from 'knex';
import { LoggerService } from '../common/services/logger.service';
import { DiscoverRepository, DiscoverCruxFilters, DiscoverAuthorFilters } from './discover.repository';

@Injectable()
export class DiscoverService {
  // @ts-expect-error - logger
  private readonly logger: LoggerService;

  constructor(
    private readonly discoverRepository: DiscoverRepository,
    private readonly loggerService: LoggerService,
  ) {
    this.logger = this.loggerService.createChildLogger('DiscoverService');
  }

  getCruxesQuery(filters: DiscoverCruxFilters): Knex.QueryBuilder {
    return this.discoverRepository.findCruxesQuery(filters);
  }

  getAuthorsQuery(filters: DiscoverAuthorFilters): Knex.QueryBuilder {
    return this.discoverRepository.findAuthorsQuery(filters);
  }

  async getPopularTags(limit?: number) {
    return this.discoverRepository.findPopularTags(limit);
  }
}
