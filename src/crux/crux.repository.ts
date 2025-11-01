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

  async findByAuthorAndSlug(
    authorId: string,
    slug: string,
  ): Promise<RepositoryResponse<CruxRaw>> {
    try {
      const data = await this.dbService
        .query()
        .from<CruxRaw>(CruxRepository.TABLE_NAME)
        .select(CruxRepository.BASE_SELECT)
        .where('author_id', authorId)
        .where('slug', slug)
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

  async delete(
    cruxId: string,
    trx?: Knex.Transaction,
  ): Promise<RepositoryResponse<void>> {
    try {
      const now = new Date();
      const query = trx || this.dbService.query();

      // First, get the crux to find its author
      const crux = await query
        .from<CruxRaw>(CruxRepository.TABLE_NAME)
        .where('id', cruxId)
        .first();

      if (!crux) {
        return failure(new Error('Crux not found'));
      }

      // Soft delete the crux
      await query
        .from<CruxRaw>(CruxRepository.TABLE_NAME)
        .where('id', cruxId)
        .update({
          deleted: now,
          updated: now,
        });

      // Also soft delete all dimensions where:
      // 1. This crux is involved (source OR target)
      // 2. AND the dimension was created by the same author as the crux
      // This preserves other people's dimensions that reference this crux
      await query
        .from('dimensions')
        .where(function () {
          this.where('source_id', cruxId).orWhere('target_id', cruxId);
        })
        .andWhere('author_id', crux.author_id)
        .update({
          deleted: now,
          updated: now,
        });

      return success(undefined);
    } catch (error) {
      return failure(error);
    }
  }

  async findAllByAuthorId(
    authorId: string,
  ): Promise<RepositoryResponse<CruxRaw[]>> {
    try {
      const data = await this.dbService
        .query()
        .from<CruxRaw>(CruxRepository.TABLE_NAME)
        .select(CruxRepository.BASE_SELECT)
        .where('author_id', authorId)
        .whereNull('deleted');

      return success(data);
    } catch (error) {
      return failure(error);
    }
  }
}
