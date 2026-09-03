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

  async findByHostname(
    hostname: string,
  ): Promise<RepositoryResponse<CustomDomainRow | undefined>> {
    try {
      const data = await this.dbService
        .query()
        .from<CustomDomainRow>(DomainsRepository.TABLE)
        .where('hostname', hostname)
        .whereNull('deleted')
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

  /** Soft delete; the hostname stays unique so the same name can't be re-added while a tenant lingers. Hard-deletes on purpose. */
  async remove(id: string): Promise<RepositoryResponse<void>> {
    try {
      await this.dbService
        .query()
        .from(DomainsRepository.TABLE)
        .where('id', id)
        .delete();
      return success(undefined);
    } catch (error) {
      this.logger.error('remove failed', error as Error);
      return failure(error);
    }
  }
}
