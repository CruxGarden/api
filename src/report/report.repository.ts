import { Injectable } from '@nestjs/common';
import { Knex } from 'knex';
import { toTableFields } from '../common/helpers/case-helpers';
import { DbService } from '../common/services/db.service';
import { LoggerService } from '../common/services/logger.service';
import { RepositoryResponse } from '../common/types/interfaces';
import { success, failure } from '../common/helpers/repository-helpers';
import ReportRaw from './entities/report-raw.entity';
import { ReportStatus } from './dto/update-report.dto';

export interface CreateReport {
  id: string;
  cruxId: string;
  authorId?: string;
  cruxSlug?: string;
  cruxTitle?: string;
  reason: string;
  details?: string;
  reporterEmail?: string;
  reporterIpHash?: string;
}

export interface ReportResolution {
  status: ReportStatus;
  resolutionNote?: string;
  resolvedBy: string;
}

@Injectable()
export class ReportRepository {
  // @ts-expect-error - logger
  private readonly logger: LoggerService;

  constructor(
    private readonly dbService: DbService,
    private readonly loggerService: LoggerService,
  ) {
    this.logger = this.loggerService.createChildLogger('ReportRepository');
  }

  private static readonly TABLE_NAME = 'reports';
  private static readonly BASE_SELECT = '*';

  findAllQuery(
    status?: ReportStatus,
  ): Knex.QueryBuilder<ReportRaw, ReportRaw[]> {
    const query = this.dbService
      .query()
      .from<ReportRaw>(ReportRepository.TABLE_NAME)
      .select<ReportRaw[]>(ReportRepository.BASE_SELECT)
      .whereNull('deleted')
      .orderBy('created', 'desc') as Knex.QueryBuilder<ReportRaw, ReportRaw[]>;
    if (status) query.where('status', status);
    return query;
  }

  async findById(id: string): Promise<RepositoryResponse<ReportRaw>> {
    try {
      const data = await this.dbService
        .query()
        .from<ReportRaw>(ReportRepository.TABLE_NAME)
        .select(ReportRepository.BASE_SELECT)
        .where('id', id)
        .whereNull('deleted')
        .first();

      return success(data);
    } catch (error) {
      return failure(error);
    }
  }

  async create(report: CreateReport): Promise<RepositoryResponse<ReportRaw>> {
    try {
      await this.dbService
        .query()
        .from<ReportRaw>(ReportRepository.TABLE_NAME)
        .insert({
          ...toTableFields(report),
          status: 'open',
          created: new Date(),
          updated: new Date(),
        });

      const data = await this.dbService
        .query()
        .from<ReportRaw>(ReportRepository.TABLE_NAME)
        .select(ReportRepository.BASE_SELECT)
        .where('id', report.id)
        .first();

      return success(data);
    } catch (error) {
      return failure(error);
    }
  }

  async update(
    id: string,
    resolution: ReportResolution,
  ): Promise<RepositoryResponse<ReportRaw>> {
    try {
      await this.dbService
        .query()
        .from<ReportRaw>(ReportRepository.TABLE_NAME)
        .where('id', id)
        .whereNull('deleted')
        .update(this.resolutionFields(resolution));

      return this.findById(id);
    } catch (error) {
      return failure(error);
    }
  }

  /** A takedown answers every report still open against that crux. */
  async resolveOpenForCrux(
    cruxId: string,
    resolution: ReportResolution,
  ): Promise<RepositoryResponse<number>> {
    try {
      const count = await this.dbService
        .query()
        .from<ReportRaw>(ReportRepository.TABLE_NAME)
        .where('crux_id', cruxId)
        .where('status', 'open')
        .whereNull('deleted')
        .update(this.resolutionFields(resolution));

      return success(count);
    } catch (error) {
      return failure(error);
    }
  }

  private resolutionFields(resolution: ReportResolution) {
    const now = new Date();
    const open = resolution.status === 'open';
    return {
      status: resolution.status,
      resolution_note: resolution.resolutionNote ?? null,
      // Reopening clears who closed it and when.
      resolved_by: open ? null : resolution.resolvedBy,
      resolved: open ? null : now,
      updated: now,
    };
  }
}
