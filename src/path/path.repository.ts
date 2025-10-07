import { Injectable } from '@nestjs/common';
import { Knex } from 'knex';
import { toTableFields } from '../common/helpers/case-helpers';
import { DbService } from '../common/services/db.service';
import { LoggerService } from '../common/services/logger.service';
import { RepositoryResponse } from '../common/types/interfaces';
import { success, failure } from '../common/helpers/repository-helpers';
import PathRaw from './entities/path-raw.entity';
import MarkerRaw from './entities/marker-raw.entity';
import { CreatePathDto } from './dto/create-path.dto';
import { UpdatePathDto } from './dto/update-path.dto';
import { CreateMarkerDto } from './dto/create-marker.dto';

@Injectable()
export class PathRepository {
  private readonly logger: LoggerService;

  constructor(
    private readonly dbService: DbService,
    private readonly loggerService: LoggerService,
  ) {
    this.logger = this.loggerService.createChildLogger('PathRepository');
    this.logger.debug('PathRepository initialized');
  }

  private static readonly TABLE_NAME = 'paths';
  private static readonly MARKER_TABLE_NAME = 'markers';
  private static readonly BASE_SELECT = '*';

  findAllQuery(): Knex.QueryBuilder<PathRaw, PathRaw[]> {
    return this.dbService
      .query()
      .from<PathRaw>(PathRepository.TABLE_NAME)
      .select<PathRaw[]>(PathRepository.BASE_SELECT)
      .whereNull('deleted')
      .orderBy('created', 'desc') as Knex.QueryBuilder<PathRaw, PathRaw[]>;
  }

  async findBy(
    fieldName: string,
    fieldValue: string,
  ): Promise<RepositoryResponse<PathRaw>> {
    try {
      const data = await this.dbService
        .query()
        .from<PathRaw>(PathRepository.TABLE_NAME)
        .select(PathRepository.BASE_SELECT)
        .where(fieldName, fieldValue)
        .whereNull('deleted')
        .first();

      return success(data);
    } catch (error) {
      return failure(error);
    }
  }

  async create(pathData: CreatePathDto): Promise<RepositoryResponse<PathRaw>> {
    try {
      const tableFields = toTableFields(pathData);

      await this.dbService
        .query()
        .from<PathRaw>(PathRepository.TABLE_NAME)
        .insert({
          ...tableFields,
          created: new Date(),
          updated: new Date(),
        });

      const data = await this.dbService
        .query()
        .from<PathRaw>(PathRepository.TABLE_NAME)
        .select(PathRepository.BASE_SELECT)
        .where('id', pathData.id)
        .first();

      return success(data);
    } catch (error) {
      return failure(error);
    }
  }

  async update(
    pathId: string,
    updateData: UpdatePathDto,
  ): Promise<RepositoryResponse<PathRaw>> {
    try {
      const tableFields = toTableFields(updateData);

      await this.dbService
        .query()
        .from<PathRaw>(PathRepository.TABLE_NAME)
        .where('id', pathId)
        .update({
          ...tableFields,
          updated: new Date(),
        });

      const data = await this.dbService
        .query()
        .from<PathRaw>(PathRepository.TABLE_NAME)
        .select(PathRepository.BASE_SELECT)
        .where('id', pathId)
        .first();

      return success(data);
    } catch (error) {
      return failure(error);
    }
  }

  async delete(pathId: string): Promise<RepositoryResponse<void>> {
    try {
      await this.dbService
        .query()
        .from<PathRaw>(PathRepository.TABLE_NAME)
        .where('id', pathId)
        .update({
          deleted: new Date(),
          updated: new Date(),
        });

      return success(undefined);
    } catch (error) {
      return failure(error);
    }
  }

  /* markers */

  async findMarkersByPathId(
    pathId: string,
  ): Promise<RepositoryResponse<MarkerRaw[]>> {
    try {
      const data = await this.dbService
        .query()
        .from<MarkerRaw>(PathRepository.MARKER_TABLE_NAME)
        .select(PathRepository.BASE_SELECT)
        .where('path_id', pathId)
        .whereNull('deleted')
        .orderBy('order', 'asc');

      return success(data);
    } catch (error) {
      return failure(error);
    }
  }

  async createMarker(
    markerData: CreateMarkerDto,
  ): Promise<RepositoryResponse<MarkerRaw>> {
    try {
      const tableFields = toTableFields(markerData);

      await this.dbService
        .query()
        .from<MarkerRaw>(PathRepository.MARKER_TABLE_NAME)
        .insert({
          ...tableFields,
          created: new Date(),
          updated: new Date(),
        });

      const data = await this.dbService
        .query()
        .from<MarkerRaw>(PathRepository.MARKER_TABLE_NAME)
        .select(PathRepository.BASE_SELECT)
        .where('id', markerData.id)
        .first();

      return success(data);
    } catch (error) {
      return failure(error);
    }
  }

  async deleteMarkersByPathId(
    pathId: string,
  ): Promise<RepositoryResponse<void>> {
    try {
      await this.dbService
        .query()
        .from<MarkerRaw>(PathRepository.MARKER_TABLE_NAME)
        .where('path_id', pathId)
        .update({
          deleted: new Date(),
          updated: new Date(),
        });

      return success(undefined);
    } catch (error) {
      return failure(error);
    }
  }

  /* ~markers */
}
