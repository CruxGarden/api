import { Injectable } from '@nestjs/common';
import { Knex } from 'knex';
import { toTableFields } from '../common/helpers/case-helpers';
import { DbService } from '../common/services/db.service';
import { LoggerService } from '../common/services/logger.service';
import { RepositoryResponse } from '../common/types/interfaces';
import { success, failure } from '../common/helpers/repository-helpers';
import { ResourceType } from '../common/types/enums';
import TagRaw from './entities/tag-raw.entity';
import Tag from './entities/tag.entity';
import { UpdateTagDto } from './dto/update-tag.dto';

@Injectable()
export class TagRepository {
  // @ts-expect-error - logger
  private readonly logger: LoggerService;

  constructor(
    private readonly dbService: DbService,
    private readonly loggerService: LoggerService,
  ) {
    this.logger = this.loggerService.createChildLogger('TagRepository');
  }

  private static readonly TABLE_NAME = 'tags';
  private static readonly BASE_SELECT = '*';

  findAllQuery(
    resourceType?: ResourceType,
    search?: string,
    sort: 'alpha' | 'count' = 'count',
    label?: string,
  ): Knex.QueryBuilder<TagRaw, TagRaw[]> {
    const query = this.dbService
      .query()
      .from<TagRaw>(TagRepository.TABLE_NAME)
      .select(TagRepository.BASE_SELECT)
      .whereNull('deleted');

    if (resourceType) {
      query.where('resource_type', resourceType);
    }

    if (search) {
      query.where('label', 'ilike', `%${search}%`);
    }

    if (label) {
      query.where('label', label.toLowerCase());
    }

    if (sort === 'alpha') {
      query.orderBy('label', 'asc');
    } else {
      query
        .groupBy('label')
        .count('* as count')
        .orderBy('count', 'desc')
        .orderBy('label', 'asc');
    }

    return query;
  }

  async findBy(
    fieldName: string,
    fieldValue: string,
  ): Promise<RepositoryResponse<TagRaw>> {
    try {
      const data = await this.dbService
        .query()
        .from<TagRaw>(TagRepository.TABLE_NAME)
        .select(TagRepository.BASE_SELECT)
        .where(fieldName, fieldValue)
        .whereNull('deleted')
        .first();

      return success(data);
    } catch (error) {
      return failure(error);
    }
  }

  async update(
    tagId: string,
    updateData: UpdateTagDto,
  ): Promise<RepositoryResponse<TagRaw>> {
    try {
      const tableFields = toTableFields(updateData);

      await this.dbService
        .query()
        .from<TagRaw>(TagRepository.TABLE_NAME)
        .where('id', tagId)
        .update({
          ...tableFields,
          updated: new Date(),
        });

      const updated = await this.dbService
        .query()
        .from<TagRaw>(TagRepository.TABLE_NAME)
        .select(TagRepository.BASE_SELECT)
        .where('id', tagId)
        .first();

      return success(updated);
    } catch (error) {
      return failure(error);
    }
  }

  async delete(tagId: string): Promise<RepositoryResponse<void>> {
    try {
      await this.dbService
        .query()
        .from<TagRaw>(TagRepository.TABLE_NAME)
        .where('id', tagId)
        .update({
          deleted: new Date(),
          updated: new Date(),
        });

      return success(undefined);
    } catch (error) {
      return failure(error);
    }
  }

  async findByResource(
    resourceType: ResourceType,
    resourceId: string,
  ): Promise<RepositoryResponse<TagRaw[]>> {
    try {
      const data = await this.dbService
        .query()
        .from<TagRaw>(TagRepository.TABLE_NAME)
        .select(TagRepository.BASE_SELECT)
        .where('resource_type', resourceType)
        .where('resource_id', resourceId)
        .whereNull('deleted')
        .orderBy('created', 'asc');

      return success(data);
    } catch (error) {
      return failure(error);
    }
  }

  async deleteByResource(
    resourceType: ResourceType,
    resourceId: string,
  ): Promise<RepositoryResponse<void>> {
    try {
      await this.dbService
        .query()
        .from<TagRaw>(TagRepository.TABLE_NAME)
        .where('resource_type', resourceType)
        .where('resource_id', resourceId)
        .update({
          deleted: new Date(),
          updated: new Date(),
        });

      return success(undefined);
    } catch (error) {
      return failure(error);
    }
  }

  async createMany(
    tags: Partial<Tag>[],
  ): Promise<RepositoryResponse<TagRaw[]>> {
    try {
      const tableFieldsArray = tags.map((tag) => toTableFields(tag));

      await this.dbService
        .query()
        .from<TagRaw>(TagRepository.TABLE_NAME)
        .insert(tableFieldsArray);

      const ids = tags.map((tag) => tag.id);
      const data = await this.dbService
        .query()
        .from<TagRaw>(TagRepository.TABLE_NAME)
        .select(TagRepository.BASE_SELECT)
        .whereIn('id', ids);

      return success(data);
    } catch (error) {
      return failure(error);
    }
  }
}
