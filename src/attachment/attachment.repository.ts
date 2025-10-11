import { Injectable } from '@nestjs/common';
import { Knex } from 'knex';
import { toTableFields } from '../common/helpers/case-helpers';
import { DbService } from '../common/services/db.service';
import { LoggerService } from '../common/services/logger.service';
import { RepositoryResponse } from '../common/types/interfaces';
import { success, failure } from '../common/helpers/repository-helpers';
import AttachmentRaw from './entities/attachment-raw.entity';
import { CreateAttachmentDto } from './dto/create-attachment.dto';
import { UpdateAttachmentDto } from './dto/update-attachment.dto';

@Injectable()
export class AttachmentRepository {
  private readonly logger: LoggerService;

  constructor(
    private readonly dbService: DbService,
    private readonly loggerService: LoggerService,
  ) {
    this.logger = this.loggerService.createChildLogger('AttachmentRepository');
    this.logger.debug('AttachmentRepository initialized');
  }

  private static readonly TABLE_NAME = 'attachments';
  private static readonly BASE_SELECT = '*';

  findAllQuery(): Knex.QueryBuilder<AttachmentRaw, AttachmentRaw[]> {
    return this.dbService
      .query()
      .from<AttachmentRaw>(AttachmentRepository.TABLE_NAME)
      .select<AttachmentRaw[]>(AttachmentRepository.BASE_SELECT)
      .whereNull('deleted')
      .orderBy('created', 'desc') as Knex.QueryBuilder<
      AttachmentRaw,
      AttachmentRaw[]
    >;
  }

  async findBy(
    fieldName: string,
    fieldValue: string,
  ): Promise<RepositoryResponse<AttachmentRaw>> {
    try {
      const data = await this.dbService
        .query()
        .from<AttachmentRaw>(AttachmentRepository.TABLE_NAME)
        .select(AttachmentRepository.BASE_SELECT)
        .where(fieldName, fieldValue)
        .whereNull('deleted')
        .first();

      return success(data);
    } catch (error) {
      return failure(error);
    }
  }

  async findByResource(
    resourceType: string,
    resourceId: string,
  ): Promise<RepositoryResponse<AttachmentRaw[]>> {
    try {
      const data = await this.dbService
        .query()
        .from<AttachmentRaw>(AttachmentRepository.TABLE_NAME)
        .select(AttachmentRepository.BASE_SELECT)
        .where('resource_type', resourceType)
        .where('resource_id', resourceId)
        .whereNull('deleted')
        .orderBy('created', 'desc');

      return success(data);
    } catch (error) {
      return failure(error);
    }
  }

  async create(
    createData: CreateAttachmentDto,
  ): Promise<RepositoryResponse<AttachmentRaw>> {
    try {
      const tableFields = toTableFields(createData);

      await this.dbService
        .query()
        .from<AttachmentRaw>(AttachmentRepository.TABLE_NAME)
        .insert({
          ...tableFields,
          created: new Date(),
          updated: new Date(),
        });

      const created = await this.dbService
        .query()
        .from<AttachmentRaw>(AttachmentRepository.TABLE_NAME)
        .select(AttachmentRepository.BASE_SELECT)
        .where('id', createData.id)
        .first();

      return success(created);
    } catch (error) {
      return failure(error);
    }
  }

  async update(
    attachmentId: string,
    updateData: UpdateAttachmentDto,
  ): Promise<RepositoryResponse<AttachmentRaw>> {
    try {
      const tableFields = toTableFields(updateData);

      await this.dbService
        .query()
        .from<AttachmentRaw>(AttachmentRepository.TABLE_NAME)
        .where('id', attachmentId)
        .update({
          ...tableFields,
          updated: new Date(),
        });

      const updated = await this.dbService
        .query()
        .from<AttachmentRaw>(AttachmentRepository.TABLE_NAME)
        .select(AttachmentRepository.BASE_SELECT)
        .where('id', attachmentId)
        .first();

      return success(updated);
    } catch (error) {
      return failure(error);
    }
  }

  async delete(attachmentId: string): Promise<RepositoryResponse<void>> {
    try {
      await this.dbService
        .query()
        .from<AttachmentRaw>(AttachmentRepository.TABLE_NAME)
        .where('id', attachmentId)
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
