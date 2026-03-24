import { Injectable } from '@nestjs/common';
import { Knex } from 'knex';
import { LoggerService } from '../common/services/logger.service';
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

  async getPopularTags(limit?: number) {
    return this.exploreRepository.findPopularTags(limit);
  }
}
