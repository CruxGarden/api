import { Injectable } from '@nestjs/common';
import { DbService } from '../common/services/db.service';
import { LoggerService } from '../common/services/logger.service';
import { RepositoryResponse } from '../common/types/interfaces';
import { success, failure } from '../common/helpers/repository-helpers';

export type DomainStatus = 'pending_dns' | 'issuing' | 'active' | 'failed';

export interface CustomDomainRow {
  id: string;
  crux_id: string;
  author_id: string;
  hostname: string;
  status: DomainStatus;
  token: string;
  tenant_id: string | null;
  error: string | null;
  created: Date;
  updated: Date;
  deleted: Date | null;
}

@Injectable()
export class DomainsRepository {
  private readonly logger: LoggerService;
  private static readonly TABLE = 'custom_domains';
  constructor(
    private readonly dbService: DbService,
    loggerService: LoggerService,
  ) {
    this.logger = loggerService.createChildLogger('DomainsRepository');
  }

  async create(
    row: Pick<CustomDomainRow, 'crux_id' | 'author_id' | 'hostname' | 'token'>,
  ): Promise<RepositoryResponse<CustomDomainRow>> {
    try {
      const [data] = await this.dbService
        .query()
        .from(DomainsRepository.TABLE)
        .insert(row)
        .returning('*');
      return success(data as CustomDomainRow);
    } catch (error) {
      this.logger.error('create failed', error as Error);
      return failure(error);
    }
  }

  async findById(
    id: string,
  ): Promise<RepositoryResponse<CustomDomainRow | undefined>> {
    try {
      const data = await this.dbService
        .query()
        .from<CustomDomainRow>(DomainsRepository.TABLE)
        .where('id', id)
        .whereNull('deleted')
        .first();
      return success(data);
    } catch (error) {
      this.logger.error('findById failed', error as Error);
      return failure(error);
    }
  }

  /** The live (issuing/active) row for a hostname — the one that owns it. */
  async findLiveByHostname(
    hostname: string,
  ): Promise<RepositoryResponse<CustomDomainRow | undefined>> {
    try {
      const data = await this.dbService
        .query()
        .from<CustomDomainRow>(DomainsRepository.TABLE)
        .where('hostname', hostname)
        .whereIn('status', ['issuing', 'active'])
        .whereNull('deleted')
        .first();
      return success(data);
    } catch (error) {
      this.logger.error('findLiveByHostname failed', error as Error);
      return failure(error);
    }
  }

  /** Release pending_dns / failed claims older than `days` (soft delete). */
  async expirePending(days: number): Promise<RepositoryResponse<number>> {
    try {
      const n = await this.dbService
        .query()
        .from(DomainsRepository.TABLE)
        .whereIn('status', ['pending_dns', 'failed'])
        .whereNull('deleted')
        .where('updated', '<', new Date(Date.now() - days * 86_400_000))
        .update({ deleted: new Date(), updated: new Date() });
      return success(n);
    } catch (error) {
      this.logger.error('expirePending failed', error as Error);
      return failure(error);
    }
  }

  /** Any live row for a hostname, live connection first (used by resolve). */
  async findByHostname(
    hostname: string,
  ): Promise<RepositoryResponse<CustomDomainRow | undefined>> {
    try {
      const data = await this.dbService
        .query()
        .from<CustomDomainRow>(DomainsRepository.TABLE)
        .where('hostname', hostname)
        .whereNull('deleted')
        .orderByRaw(
          `CASE status WHEN 'active' THEN 0 WHEN 'issuing' THEN 1 ELSE 2 END`,
        )
        .first();
      return success(data);
    } catch (error) {
      this.logger.error('findByHostname failed', error as Error);
      return failure(error);
    }
  }

  async findByCrux(
    cruxId: string,
  ): Promise<RepositoryResponse<CustomDomainRow[]>> {
    try {
      const data = await this.dbService
        .query()
        .from<CustomDomainRow>(DomainsRepository.TABLE)
        .where('crux_id', cruxId)
        .whereNull('deleted')
        .orderBy('created', 'asc');
      return success(data);
    } catch (error) {
      this.logger.error('findByCrux failed', error as Error);
      return failure(error);
    }
  }

  async findIssuing(): Promise<RepositoryResponse<CustomDomainRow[]>> {
    try {
      const data = await this.dbService
        .query()
        .from<CustomDomainRow>(DomainsRepository.TABLE)
        .where('status', 'issuing')
        .whereNull('deleted');
      return success(data);
    } catch (error) {
      this.logger.error('findIssuing failed', error as Error);
      return failure(error);
    }
  }

  async update(
    id: string,
    patch: Partial<CustomDomainRow>,
  ): Promise<RepositoryResponse<CustomDomainRow>> {
    try {
      const [data] = await this.dbService
        .query()
        .from(DomainsRepository.TABLE)
        .where('id', id)
        .update({ ...patch, updated: new Date() })
        .returning('*');
      return success(data as CustomDomainRow);
    } catch (error) {
      this.logger.error('update failed', error as Error);
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

  /** Soft delete, like every other table; the live-hostname index ignores deleted rows. */
  async remove(id: string): Promise<RepositoryResponse<void>> {
    try {
      await this.dbService
        .query()
        .from(DomainsRepository.TABLE)
        .where('id', id)
        .update({ deleted: new Date(), updated: new Date() });
      return success(undefined);
    } catch (error) {
      this.logger.error('remove failed', error as Error);
      return failure(error);
    }
  }
}
