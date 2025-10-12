import { Injectable } from '@nestjs/common';
import { Knex } from 'knex';
import { toTableFields } from '../common/helpers/case-helpers';
import { DbService } from '../common/services/db.service';
import { LoggerService } from '../common/services/logger.service';
import { CreateAuthorDto } from './dto/create-author.dto';
import { UpdateAuthorDto } from './dto/update-author.dto';
import { RepositoryResponse } from '../common/types/interfaces';
import { success, failure } from '../common/helpers/repository-helpers';
import AuthorRaw from './entities/author-raw.entity';

@Injectable()
export class AuthorRepository {
  // @ts-expect-error - logger
  private readonly logger: LoggerService;

  constructor(
    private readonly dbService: DbService,
    private readonly loggerService: LoggerService,
  ) {
    this.logger = this.loggerService.createChildLogger('AuthorRepository');
  }

  private static readonly TABLE_NAME = 'authors';
  private static readonly BASE_SELECT = '*';

  findAllQuery(): Knex.QueryBuilder<AuthorRaw, AuthorRaw[]> {
    return this.dbService
      .query()
      .from<AuthorRaw>(AuthorRepository.TABLE_NAME)
      .select<AuthorRaw[]>(AuthorRepository.BASE_SELECT)
      .whereNull('deleted')
      .orderBy('created', 'desc') as Knex.QueryBuilder<AuthorRaw, AuthorRaw[]>;
  }

  async findBy(
    fieldName: string,
    fieldValue: string,
  ): Promise<RepositoryResponse<AuthorRaw>> {
    try {
      const data = await this.dbService
        .query()
        .from<AuthorRaw>(AuthorRepository.TABLE_NAME)
        .select(AuthorRepository.BASE_SELECT)
        .where(fieldName, fieldValue)
        .whereNull('deleted')
        .first();

      return success(data);
    } catch (error) {
      return failure(error);
    }
  }

  async create(
    createData: CreateAuthorDto,
  ): Promise<RepositoryResponse<AuthorRaw>> {
    try {
      const tableFields = toTableFields(createData);

      await this.dbService
        .query()
        .from<AuthorRaw>(AuthorRepository.TABLE_NAME)
        .insert({
          ...tableFields,
          created: new Date(),
          updated: new Date(),
        });

      const created = await this.dbService
        .query()
        .from<AuthorRaw>(AuthorRepository.TABLE_NAME)
        .select(AuthorRepository.BASE_SELECT)
        .where('id', createData.id)
        .first();

      return success(created);
    } catch (error) {
      return failure(error);
    }
  }

  async update(
    authorId: string,
    updateData: UpdateAuthorDto,
  ): Promise<RepositoryResponse<AuthorRaw>> {
    try {
      const tableFields = toTableFields(updateData);

      await this.dbService
        .query()
        .from<AuthorRaw>(AuthorRepository.TABLE_NAME)
        .where('id', authorId)
        .update({
          ...tableFields,
          updated: new Date(),
        });

      const updated = await this.dbService
        .query()
        .from<AuthorRaw>(AuthorRepository.TABLE_NAME)
        .select(AuthorRepository.BASE_SELECT)
        .where('id', authorId)
        .first();

      return success(updated);
    } catch (error) {
      return failure(error);
    }
  }

  async delete(authorId: string): Promise<RepositoryResponse<void>> {
    try {
      await this.dbService
        .query()
        .from<AuthorRaw>(AuthorRepository.TABLE_NAME)
        .where('id', authorId)
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
