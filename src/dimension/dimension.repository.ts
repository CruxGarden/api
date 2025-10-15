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
    embedSource = false,
    embedTarget = true,
  ): Knex.QueryBuilder<DimensionRaw, DimensionRaw[]> {
    const tableName = DimensionRepository.TABLE_NAME;

    let query: any = this.dbService.query().from(tableName);

    // Conditionally add target join
    if (embedTarget) {
      query = query.leftJoin(
        'cruxes as target_crux',
        `${tableName}.target_id`,
        'target_crux.id',
      );
    }

    // Conditionally add source join
    if (embedSource) {
      query = query.leftJoin(
        'cruxes as source_crux',
        `${tableName}.source_id`,
        'source_crux.id',
      );
    }

    // Build select clause based on what's embedded
    const selectColumns = [`${tableName}.*`];
    if (embedTarget) {
      selectColumns.push(
        'target_crux.key as target_key',
        'target_crux.slug as target_slug',
        'target_crux.title as target_title',
        'target_crux.data as target_data',
      );
    }
    if (embedSource) {
      selectColumns.push(
        'source_crux.key as source_key',
        'source_crux.slug as source_slug',
        'source_crux.title as source_title',
        'source_crux.data as source_data',
      );
    }

    query = query
      .select(selectColumns)
      .where(`${tableName}.source_id`, sourceId)
      .whereNull(`${tableName}.deleted`)
      .orderBy(`${tableName}.created`, 'desc');

    if (type) {
      query = query.where(`${tableName}.type`, type);
    }

    return query as Knex.QueryBuilder<DimensionRaw, DimensionRaw[]>;
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
