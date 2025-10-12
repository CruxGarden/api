import { Injectable } from '@nestjs/common';
import { Knex } from 'knex';
import { DbService } from '../common/services/db.service';
import { LoggerService } from '../common/services/logger.service';
import { RepositoryResponse } from '../common/types/interfaces';
import { success, failure } from '../common/helpers/repository-helpers';
import { toTableFields } from '../common/helpers/case-helpers';
import DimensionRaw from './entities/dimension-raw.entity';
import { CreateDimensionDto } from './dto/create-dimension.dto';
import { UpdateDimensionDto } from './dto/update-dimension.dto';
import { DimensionType } from 'src/common';

@Injectable()
export class DimensionRepository {
  // @ts-expect-error - logger
  private readonly logger: LoggerService;

  constructor(
    private readonly dbService: DbService,
    private readonly loggerService: LoggerService,
  ) {
    this.logger = this.loggerService.createChildLogger('DimensionRepository');
  }

  private static readonly TABLE_NAME = 'dimensions';
  private static readonly BASE_SELECT = '*';

  findBySourceIdAndTypeQuery(
    sourceId: string,
    type?: DimensionType,
  ): Knex.QueryBuilder<DimensionRaw, DimensionRaw[]> {
    let query = this.dbService
      .query()
      .from<DimensionRaw>(DimensionRepository.TABLE_NAME)
      .select<DimensionRaw[]>(DimensionRepository.BASE_SELECT)
      .where('source_id', sourceId)
      .whereNull('deleted')
      .orderBy('created', 'desc') as Knex.QueryBuilder<
      DimensionRaw,
      DimensionRaw[]
    >;

    if (type) {
      query = query.where('type', type);
    }

    return query;
  }

  async findBy(
    fieldName: string,
    fieldValue: string,
  ): Promise<RepositoryResponse<DimensionRaw>> {
    try {
      const data = await this.dbService
        .query()
        .from<DimensionRaw>(DimensionRepository.TABLE_NAME)
        .select(DimensionRepository.BASE_SELECT)
        .where(fieldName, fieldValue)
        .whereNull('deleted')
        .first();

      return success(data);
    } catch (error) {
      return failure(error);
    }
  }

  async create(
    dimensionData: CreateDimensionDto,
  ): Promise<RepositoryResponse<DimensionRaw>> {
    try {
      const tableFields = toTableFields(dimensionData);

      await this.dbService
        .query()
        .from<DimensionRaw>(DimensionRepository.TABLE_NAME)
        .insert({
          ...tableFields,
          created: new Date(),
          updated: new Date(),
        });

      const data = await this.dbService
        .query()
        .from<DimensionRaw>(DimensionRepository.TABLE_NAME)
        .select(DimensionRepository.BASE_SELECT)
        .where('id', dimensionData.id)
        .first();

      return success(data);
    } catch (error) {
      return failure(error);
    }
  }

  async update(
    dimensionId: string,
    updateData: UpdateDimensionDto,
  ): Promise<RepositoryResponse<DimensionRaw>> {
    try {
      const tableFields = toTableFields(updateData);

      await this.dbService
        .query()
        .from<DimensionRaw>(DimensionRepository.TABLE_NAME)
        .where('id', dimensionId)
        .update({
          ...tableFields,
          updated: new Date(),
        });

      const data = await this.dbService
        .query()
        .from<DimensionRaw>(DimensionRepository.TABLE_NAME)
        .select(DimensionRepository.BASE_SELECT)
        .where('id', dimensionId)
        .first();

      return success(data);
    } catch (error) {
      return failure(error);
    }
  }

  async delete(dimensionId: string): Promise<RepositoryResponse<void>> {
    try {
      await this.dbService
        .query()
        .from<DimensionRaw>(DimensionRepository.TABLE_NAME)
        .where('id', dimensionId)
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
