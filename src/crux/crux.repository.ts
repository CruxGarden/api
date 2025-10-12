import { Injectable } from '@nestjs/common';
import { Knex } from 'knex';
import { toTableFields } from '../common/helpers/case-helpers';
import { DbService } from '../common/services/db.service';
import { LoggerService } from '../common/services/logger.service';
import { RepositoryResponse } from '../common/types/interfaces';
import { success, failure } from '../common/helpers/repository-helpers';
import CruxRaw from './entities/crux-raw.entity';
import { CreateCruxDto } from './dto/create-crux.dto';
import { UpdateCruxDto } from './dto/update-crux.dto';

@Injectable()
export class CruxRepository {
  // @ts-expect-error - logger
  private readonly logger: LoggerService;

  constructor(
    private readonly dbService: DbService,
    private readonly loggerService: LoggerService,
  ) {
    this.logger = this.loggerService.createChildLogger('CruxRepository');
  }

  private static readonly TABLE_NAME = 'cruxes';
  private static readonly BASE_SELECT = '*';

  findAllQuery(): Knex.QueryBuilder<CruxRaw, CruxRaw[]> {
    return this.dbService
      .query()
      .from<CruxRaw>(CruxRepository.TABLE_NAME)
      .select<CruxRaw[]>(CruxRepository.BASE_SELECT)
      .whereNull('deleted')
      .orderBy('created', 'desc') as Knex.QueryBuilder<CruxRaw, CruxRaw[]>;
  }

  async findBy(
    fieldName: string,
    fieldValue: string,
  ): Promise<RepositoryResponse<CruxRaw>> {
    try {
      const data = await this.dbService
        .query()
        .from<CruxRaw>(CruxRepository.TABLE_NAME)
        .select(CruxRepository.BASE_SELECT)
        .where(fieldName, fieldValue)
        .whereNull('deleted')
        .first();

      return success(data);
    } catch (error) {
      return failure(error);
    }
  }

  async create(cruxData: CreateCruxDto): Promise<RepositoryResponse<CruxRaw>> {
    try {
      const tableFields = toTableFields(cruxData);

      await this.dbService
        .query()
        .from<CruxRaw>(CruxRepository.TABLE_NAME)
        .insert({
          ...tableFields,
          created: new Date(),
          updated: new Date(),
        });

      const data = await this.dbService
        .query()
        .from<CruxRaw>(CruxRepository.TABLE_NAME)
        .select(CruxRepository.BASE_SELECT)
        .where('id', cruxData.id)
        .first();

      return success(data);
    } catch (error) {
      return failure(error);
    }
  }

  async update(
    cruxId: string,
    updateData: UpdateCruxDto,
  ): Promise<RepositoryResponse<CruxRaw>> {
    try {
      const tableFields = toTableFields(updateData);

      await this.dbService
        .query()
        .from<CruxRaw>(CruxRepository.TABLE_NAME)
        .where('id', cruxId)
        .update({
          ...tableFields,
          updated: new Date(),
        });

      const data = await this.dbService
        .query()
        .from<CruxRaw>(CruxRepository.TABLE_NAME)
        .select(CruxRepository.BASE_SELECT)
        .where('id', cruxId)
        .first();

      return success(data);
    } catch (error) {
      return failure(error);
    }
  }

  async delete(cruxId: string): Promise<RepositoryResponse<void>> {
    try {
      await this.dbService
        .query()
        .from<CruxRaw>(CruxRepository.TABLE_NAME)
        .where('id', cruxId)
        .update({
          deleted: new Date(),
          updated: new Date(),
        });

      return success(undefined);
    } catch (error) {
      return failure(error);
    }
  }
}
