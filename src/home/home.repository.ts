import { Injectable } from '@nestjs/common';
import { Knex } from 'knex';
import { toTableFields } from '../common/helpers/case-helpers';
import { DbService } from '../common/services/db.service';
import { LoggerService } from '../common/services/logger.service';
import { RepositoryResponse } from '../common/types/interfaces';
import { success, failure } from '../common/helpers/repository-helpers';
import HomeRaw from './entities/home-raw.entity';
import { CreateHomeDto } from './dto/create-home.dto';
import { UpdateHomeDto } from './dto/update-home.dto';

@Injectable()
export class HomeRepository {
  // @ts-expect-error - logger
  private readonly logger: LoggerService;

  constructor(
    private readonly dbService: DbService,
    private readonly loggerService: LoggerService,
  ) {
    this.logger = this.loggerService.createChildLogger('HomeRepository');
  }

  private static readonly TABLE_NAME = 'homes';
  private static readonly BASE_SELECT = '*';

  findAllQuery(): Knex.QueryBuilder<HomeRaw, HomeRaw[]> {
    return this.dbService
      .query()
      .from<HomeRaw>(HomeRepository.TABLE_NAME)
      .select<HomeRaw[]>(HomeRepository.BASE_SELECT)
      .whereNull('deleted')
      .orderBy('created', 'desc') as Knex.QueryBuilder<HomeRaw, HomeRaw[]>;
  }

  async findBy(
    fieldName: string,
    fieldValue: string | boolean,
  ): Promise<RepositoryResponse<HomeRaw>> {
    try {
      const data = await this.dbService
        .query()
        .from<HomeRaw>(HomeRepository.TABLE_NAME)
        .select(HomeRepository.BASE_SELECT)
        .where(fieldName, fieldValue)
        .whereNull('deleted')
        .first();

      return success(data);
    } catch (error) {
      return failure(error);
    }
  }

  async create(
    createData: CreateHomeDto & { id: string },
  ): Promise<RepositoryResponse<HomeRaw>> {
    try {
      const tableFields = toTableFields({
        id: createData.id,
        name: createData.name,
        description: createData.description,
        primary: createData.primary,
        type: createData.type,
        kind: createData.kind,
        meta: createData.meta,
      });

      await this.dbService
        .query()
        .from<HomeRaw>(HomeRepository.TABLE_NAME)
        .insert({
          ...tableFields,
          created: new Date(),
          updated: new Date(),
        });

      const created = await this.dbService
        .query()
        .from<HomeRaw>(HomeRepository.TABLE_NAME)
        .select(HomeRepository.BASE_SELECT)
        .where('id', createData.id)
        .first();

      return success(created);
    } catch (error) {
      return failure(error);
    }
  }

  async update(
    homeId: string,
    updateData: UpdateHomeDto,
  ): Promise<RepositoryResponse<HomeRaw>> {
    try {
      const tableFields = toTableFields({
        name: updateData.name,
        description: updateData.description,
        primary: updateData.primary,
        type: updateData.type,
        kind: updateData.kind,
        meta: updateData.meta,
      });

      await this.dbService
        .query()
        .from<HomeRaw>(HomeRepository.TABLE_NAME)
        .where('id', homeId)
        .whereNull('deleted')
        .update({
          ...tableFields,
          updated: new Date(),
        });

      const updated = await this.dbService
        .query()
        .from<HomeRaw>(HomeRepository.TABLE_NAME)
        .select(HomeRepository.BASE_SELECT)
        .where('id', homeId)
        .whereNull('deleted')
        .first();

      return success(updated);
    } catch (error) {
      return failure(error);
    }
  }

  async delete(homeId: string): Promise<RepositoryResponse<void>> {
    try {
      await this.dbService
        .query()
        .from<HomeRaw>(HomeRepository.TABLE_NAME)
        .where('id', homeId)
        .whereNull('deleted')
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
