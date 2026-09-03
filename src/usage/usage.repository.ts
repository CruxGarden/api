import { Injectable } from '@nestjs/common';
import { DbService } from '../common/services/db.service';
import { LoggerService } from '../common/services/logger.service';
import { RepositoryResponse } from '../common/types/interfaces';
import { success, failure } from '../common/helpers/repository-helpers';

export interface UsageStorageRow {
  crux_id: string;
  author_id: string;
  bytes: string | number;
  files: number;
  updated: Date;
}
export interface UsageDailyRow {
  author_id: string;
  crux_id: string;
  day: string;
  bytes: string | number;
  requests: string | number;
}

@Injectable()
export class UsageRepository {
  private readonly logger: LoggerService;
  constructor(
    private readonly dbService: DbService,
    loggerService: LoggerService,
  ) {
    this.logger = loggerService.createChildLogger('UsageRepository');
  }

  async upsertStorage(
    cruxId: string,
    authorId: string,
    bytes: number,
    files: number,
  ): Promise<RepositoryResponse<void>> {
    try {
      await this.dbService
        .query()
        .from('usage_storage')
        .insert({
          crux_id: cruxId,
          author_id: authorId,
          bytes,
          files,
          updated: new Date(),
        })
        .onConflict('crux_id')
        .merge({ author_id: authorId, bytes, files, updated: new Date() });
      return success(undefined);
    } catch (error) {
      this.logger.error('upsertStorage failed', error as Error);
      return failure(error);
    }
  }

  async deleteStorage(cruxId: string): Promise<RepositoryResponse<void>> {
    try {
      await this.dbService
        .query()
        .from('usage_storage')
        .where('crux_id', cruxId)
        .delete();
      return success(undefined);
    } catch (error) {
      this.logger.error('deleteStorage failed', error as Error);
      return failure(error);
    }
  }

  async storageByAuthor(
    authorId: string,
  ): Promise<RepositoryResponse<UsageStorageRow[]>> {
    try {
      const rows = await this.dbService
        .query()
        .from<UsageStorageRow>('usage_storage')
        .where('author_id', authorId)
        .orderBy('bytes', 'desc');
      return success(rows);
    } catch (error) {
      this.logger.error('storageByAuthor failed', error as Error);
      return failure(error);
    }
  }

  /** Add (not replace) bytes/requests for a crux-day. Log files never overlap, so adding is safe. */
  async addDaily(
    authorId: string,
    cruxId: string,
    day: string,
    bytes: number,
    requests: number,
  ): Promise<RepositoryResponse<void>> {
    try {
      await this.dbService.query().raw(
        `INSERT INTO usage_daily (author_id, crux_id, day, bytes, requests)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (crux_id, day) DO UPDATE SET
           bytes = usage_daily.bytes + EXCLUDED.bytes,
           requests = usage_daily.requests + EXCLUDED.requests,
           author_id = EXCLUDED.author_id,
           updated = now()`,
        [authorId, cruxId, day, bytes, requests],
      );
      return success(undefined);
    } catch (error) {
      this.logger.error('addDaily failed', error as Error);
      return failure(error);
    }
  }

  async dailyByAuthor(
    authorId: string,
    start: string,
    end: string,
  ): Promise<RepositoryResponse<UsageDailyRow[]>> {
    try {
      const rows = await this.dbService
        .query()
        .from<UsageDailyRow>('usage_daily')
        .where('author_id', authorId)
        .where('day', '>=', start)
        .where('day', '<', end);
      return success(rows);
    } catch (error) {
      this.logger.error('dailyByAuthor failed', error as Error);
      return failure(error);
    }
  }

  async dailyByCrux(
    cruxId: string,
    start: string,
    end: string,
  ): Promise<RepositoryResponse<UsageDailyRow[]>> {
    try {
      const rows = await this.dbService
        .query()
        .from<UsageDailyRow>('usage_daily')
        .where('crux_id', cruxId)
        .where('day', '>=', start)
        .where('day', '<', end);
      return success(rows);
    } catch (error) {
      this.logger.error('dailyByCrux failed', error as Error);
      return failure(error);
    }
  }

  async storageByCrux(
    cruxId: string,
  ): Promise<RepositoryResponse<UsageStorageRow | undefined>> {
    try {
      const row = await this.dbService
        .query()
        .from<UsageStorageRow>('usage_storage')
        .where('crux_id', cruxId)
        .first();
      return success(row);
    } catch (error) {
      this.logger.error('storageByCrux failed', error as Error);
      return failure(error);
    }
  }

  async ingestSeen(key: string): Promise<RepositoryResponse<boolean>> {
    try {
      const row = await this.dbService
        .query()
        .from('usage_ingest')
        .where('key', key)
        .first();
      return success(!!row);
    } catch (error) {
      this.logger.error('ingestSeen failed', error as Error);
      return failure(error);
    }
  }

  async markIngested(
    key: string,
    bytes: number,
    requests: number,
  ): Promise<RepositoryResponse<void>> {
    try {
      await this.dbService
        .query()
        .from('usage_ingest')
        .insert({ key, bytes, requests })
        .onConflict('key')
        .ignore();
      return success(undefined);
    } catch (error) {
      this.logger.error('markIngested failed', error as Error);
      return failure(error);
    }
  }

  /** crux → author for hosts that aren't UUID subdomains (custom domains). */
  async cruxForHostname(
    hostname: string,
  ): Promise<
    RepositoryResponse<{ crux_id: string; author_id: string } | undefined>
  > {
    try {
      const row = await this.dbService
        .query()
        .from('custom_domains')
        .select('crux_id', 'author_id')
        .where('hostname', hostname.toLowerCase())
        .whereNull('deleted')
        .first();
      return success(row as { crux_id: string; author_id: string } | undefined);
    } catch (error) {
      this.logger.error('cruxForHostname failed', error as Error);
      return failure(error);
    }
  }

  async authorForCrux(
    cruxId: string,
  ): Promise<RepositoryResponse<string | undefined>> {
    try {
      const row = await this.dbService
        .query()
        .from('cruxes')
        .select('author_id')
        .where('id', cruxId)
        .first();
      return success((row as { author_id: string } | undefined)?.author_id);
    } catch (error) {
      this.logger.error('authorForCrux failed', error as Error);
      return failure(error);
    }
  }
}
