import { Injectable } from '@nestjs/common';
import { Knex } from 'knex';
import { toTableFields } from '../common/helpers/case-helpers';
import { DbService } from '../common/services/db.service';
import { LoggerService } from '../common/services/logger.service';
import { RepositoryResponse } from '../common/types/interfaces';
import { success, failure } from '../common/helpers/repository-helpers';
import ThemeRaw from './entities/theme-raw.entity';
import { CreateThemeDto } from './dto/create-theme.dto';
import { UpdateThemeDto } from './dto/update-theme.dto';

@Injectable()
export class ThemeRepository {
  // @ts-expect-error - logger
  private readonly logger: LoggerService;

  constructor(
    private readonly dbService: DbService,
    private readonly loggerService: LoggerService,
  ) {
    this.logger = this.loggerService.createChildLogger('ThemeRepository');
  }

  private static readonly TABLE_NAME = 'themes';
  private static readonly BASE_SELECT = '*';

  findAllQuery(): Knex.QueryBuilder<ThemeRaw, ThemeRaw[]> {
    return this.dbService
      .query()
      .from<ThemeRaw>(ThemeRepository.TABLE_NAME)
      .select<ThemeRaw[]>(ThemeRepository.BASE_SELECT)
      .whereNull('deleted')
      .orderBy('created', 'desc') as Knex.QueryBuilder<ThemeRaw, ThemeRaw[]>;
  }

  async findBy(
    fieldName: string,
    fieldValue: string,
  ): Promise<RepositoryResponse<ThemeRaw>> {
    try {
      const data = await this.dbService
        .query()
        .from<ThemeRaw>(ThemeRepository.TABLE_NAME)
        .select(ThemeRepository.BASE_SELECT)
        .where(fieldName, fieldValue)
        .whereNull('deleted')
        .first();

      return success(data);
    } catch (error) {
      return failure(error);
    }
  }

  async create(
    createData: CreateThemeDto,
  ): Promise<RepositoryResponse<ThemeRaw>> {
    try {
      const tableFields = toTableFields(createData);

      await this.dbService
        .query()
        .from<ThemeRaw>(ThemeRepository.TABLE_NAME)
        .insert({
          ...tableFields,
          created: new Date(),
          updated: new Date(),
        });

      const created = await this.dbService
        .query()
        .from<ThemeRaw>(ThemeRepository.TABLE_NAME)
        .select(ThemeRepository.BASE_SELECT)
        .where('id', createData.id)
        .first();

      return success(created);
    } catch (error) {
      return failure(error);
    }
  }

  async update(
    themeId: string,
    updateData: UpdateThemeDto,
  ): Promise<RepositoryResponse<ThemeRaw>> {
    try {
      const tableFields = toTableFields(updateData);

      await this.dbService
        .query()
        .from<ThemeRaw>(ThemeRepository.TABLE_NAME)
        .where('id', themeId)
        .update({
          ...tableFields,
          updated: new Date(),
        });

      const updated = await this.dbService
        .query()
        .from<ThemeRaw>(ThemeRepository.TABLE_NAME)
        .select(ThemeRepository.BASE_SELECT)
        .where('id', themeId)
        .first();

      return success(updated);
    } catch (error) {
      return failure(error);
    }
  }

  async delete(themeId: string): Promise<RepositoryResponse<void>> {
    try {
      await this.dbService
        .query()
        .from<ThemeRaw>(ThemeRepository.TABLE_NAME)
        .where('id', themeId)
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
