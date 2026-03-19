import { Injectable } from '@nestjs/common';
import { DbService } from '../common/services/db.service';
import { LoggerService } from '../common/services/logger.service';
import { RepositoryResponse } from '../common/types/interfaces';
import { success, failure } from '../common/helpers/repository-helpers';
import StoreRaw from './entities/crux-store-raw.entity';

@Injectable()
export class StoreRepository {
  private readonly logger: LoggerService;

  constructor(
    private readonly dbService: DbService,
    loggerService: LoggerService,
  ) {
    this.logger = loggerService.createChildLogger('StoreRepository');
  }

  private static readonly TABLE = 'store';

  async findPublicEntry(
    cruxId: string,
    key: string,
  ): Promise<RepositoryResponse<StoreRaw>> {
    try {
      const data = await this.dbService
        .query()
        .from<StoreRaw>(StoreRepository.TABLE)
        .where('crux_id', cruxId)
        .where('key', key)
        .whereNull('visitor_id')
        .first();
      return success(data);
    } catch (error) {
      this.logger.error('Store query failed', error as Error);
      return failure(error);
    }
  }

  async findProtectedEntry(
    cruxId: string,
    key: string,
    visitorId: string,
  ): Promise<RepositoryResponse<StoreRaw>> {
    try {
      const data = await this.dbService
        .query()
        .from<StoreRaw>(StoreRepository.TABLE)
        .where('crux_id', cruxId)
        .where('key', key)
        .where('visitor_id', visitorId)
        .first();
      return success(data);
    } catch (error) {
      this.logger.error('Store query failed', error as Error);
      return failure(error);
    }
  }

  async findAllByCrux(cruxId: string): Promise<RepositoryResponse<StoreRaw[]>> {
    try {
      const data = await this.dbService
        .query()
        .from<StoreRaw>(StoreRepository.TABLE)
        .where('crux_id', cruxId)
        .orderBy('key');
      return success(data);
    } catch (error) {
      this.logger.error('Store query failed', error as Error);
      return failure(error);
    }
  }

  async upsertPublic(
    id: string,
    cruxId: string,
    authorId: string,
    key: string,
    value: any,
  ): Promise<RepositoryResponse<StoreRaw>> {
    try {
      const now = new Date();
      await this.dbService
        .query()
        .from(StoreRepository.TABLE)
        .insert({
          id,
          crux_id: cruxId,
          author_id: authorId,
          visitor_id: null,
          key,
          value: JSON.stringify(value),
          mode: 'public',
          created_at: now,
          updated_at: now,
        })
        .onConflict(this.dbService.query().raw('(crux_id, key) WHERE visitor_id IS NULL'))
        .merge({
          value: JSON.stringify(value),
          updated_at: now,
        });

      const data = await this.dbService
        .query()
        .from<StoreRaw>(StoreRepository.TABLE)
        .where('crux_id', cruxId)
        .where('key', key)
        .whereNull('visitor_id')
        .first();

      return success(data);
    } catch (error) {
      this.logger.error('Store query failed', error as Error);
      return failure(error);
    }
  }

  async upsertProtected(
    id: string,
    cruxId: string,
    authorId: string,
    visitorId: string,
    key: string,
    value: any,
  ): Promise<RepositoryResponse<StoreRaw>> {
    try {
      const now = new Date();
      await this.dbService
        .query()
        .from(StoreRepository.TABLE)
        .insert({
          id,
          crux_id: cruxId,
          author_id: authorId,
          visitor_id: visitorId,
          key,
          value: JSON.stringify(value),
          mode: 'protected',
          created_at: now,
          updated_at: now,
        })
        .onConflict(
          this.dbService.query().raw('(crux_id, visitor_id, key) WHERE visitor_id IS NOT NULL'),
        )
        .merge({
          value: JSON.stringify(value),
          updated_at: now,
        });

      const data = await this.dbService
        .query()
        .from<StoreRaw>(StoreRepository.TABLE)
        .where('crux_id', cruxId)
        .where('key', key)
        .where('visitor_id', visitorId)
        .first();

      return success(data);
    } catch (error) {
      this.logger.error('Store query failed', error as Error);
      return failure(error);
    }
  }

  async atomicIncrement(
    cruxId: string,
    key: string,
    by: number,
    visitorId?: string | null,
  ): Promise<RepositoryResponse<StoreRaw>> {
    try {
      let query;
      if (visitorId) {
        query = this.dbService
          .query()
          .from(StoreRepository.TABLE)
          .where('crux_id', cruxId)
          .where('key', key)
          .where('visitor_id', visitorId);
      } else {
        query = this.dbService
          .query()
          .from(StoreRepository.TABLE)
          .where('crux_id', cruxId)
          .where('key', key)
          .whereNull('visitor_id');
      }

      const rows = await query
        .update({
          value: this.dbService.query().raw('(COALESCE(value::text, \'0\')::numeric + ?)::text::jsonb', [by]),
          updated_at: new Date(),
        })
        .returning('*');

      return success(rows?.[0] || null);
    } catch (error) {
      this.logger.error('Store query failed', error as Error);
      return failure(error);
    }
  }

  async deleteEntry(
    cruxId: string,
    key: string,
    visitorId?: string | null,
  ): Promise<RepositoryResponse<void>> {
    try {
      let query = this.dbService
        .query()
        .from(StoreRepository.TABLE)
        .where('crux_id', cruxId)
        .where('key', key);

      if (visitorId) {
        query = query.where('visitor_id', visitorId);
      } else {
        query = query.whereNull('visitor_id');
      }

      await query.del();
      return success(undefined);
    } catch (error) {
      this.logger.error('Store query failed', error as Error);
      return failure(error);
    }
  }

  async clearAllByCrux(cruxId: string): Promise<RepositoryResponse<void>> {
    try {
      await this.dbService
        .query()
        .from(StoreRepository.TABLE)
        .where('crux_id', cruxId)
        .del();
      return success(undefined);
    } catch (error) {
      this.logger.error('Store query failed', error as Error);
      return failure(error);
    }
  }

  async getStorageByAuthor(authorId: string): Promise<RepositoryResponse<number>> {
    try {
      const result = await this.dbService
        .query()
        .from(StoreRepository.TABLE)
        .where('author_id', authorId)
        .sum({ total: this.dbService.query().raw('pg_column_size(value)') })
        .first();
      return success(Number(result?.total || 0));
    } catch (error) {
      this.logger.error('Store query failed', error as Error);
      return failure(error);
    }
  }
}
