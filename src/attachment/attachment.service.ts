import {
  Injectable,
  NotFoundException,
  InternalServerErrorException,
} from '@nestjs/common';
import { Knex } from 'knex';
import { toEntityFields } from '../common/helpers/case-helpers';
import { CreateAttachmentDto } from './dto/create-attachment.dto';
import { UpdateAttachmentDto } from './dto/update-attachment.dto';
import { AttachmentRepository } from './attachment.repository';
import { KeyMaster } from '../common/services/key.master';
import { LoggerService } from '../common/services/logger.service';
import AttachmentRaw from './entities/attachment-raw.entity';
import Attachment from './entities/attachment.entity';

@Injectable()
export class AttachmentService {
  private readonly logger: LoggerService;

  constructor(
    private readonly attachmentRepository: AttachmentRepository,
    private readonly keyMaster: KeyMaster,
    private readonly loggerService: LoggerService,
  ) {
    this.logger = this.loggerService.createChildLogger('AttachmentService');
    this.logger.debug('AttachmentService initialized');
  }

  asAttachment(data: AttachmentRaw): Attachment {
    const entityFields = toEntityFields(data);
    return new Attachment(entityFields);
  }

  asAttachments(rows: AttachmentRaw[]): Attachment[] {
    return rows.map((data) => this.asAttachment(data));
  }

  findAllQuery(): Knex.QueryBuilder<AttachmentRaw, AttachmentRaw[]> {
    return this.attachmentRepository.findAllQuery();
  }

  async findById(id: string): Promise<Attachment> {
    const { data: attachment, error } = await this.attachmentRepository.findBy(
      'id',
      id,
    );

    if (error || !attachment) {
      throw new NotFoundException('Attachment not found');
    }

    return this.asAttachment(attachment);
  }

  async findByKey(key: string): Promise<Attachment> {
    const { data: attachment, error } = await this.attachmentRepository.findBy(
      'key',
      key,
    );

    if (error || !attachment) {
      throw new NotFoundException('Attachment not found');
    }

    return this.asAttachment(attachment);
  }

  async findByResource(
    resourceType: string,
    resourceId: string,
  ): Promise<Attachment[]> {
    const { data, error } = await this.attachmentRepository.findByResource(
      resourceType,
      resourceId,
    );

    if (error) {
      throw new InternalServerErrorException(
        `Error fetching attachments: ${error}`,
      );
    }

    return this.asAttachments(data || []);
  }

  async create(createAttachmentDto: CreateAttachmentDto): Promise<Attachment> {
    createAttachmentDto.id = this.keyMaster.generateId();
    createAttachmentDto.key = this.keyMaster.generateKey();

    const created = await this.attachmentRepository.create(createAttachmentDto);
    if (created.error)
      throw new InternalServerErrorException(
        `Attachment creation error: ${created.error}`,
      );

    return this.asAttachment(created.data);
  }

  async update(
    attachmentKey: string,
    updateDto: UpdateAttachmentDto,
  ): Promise<Attachment> {
    // 1) fetch attachment
    const attachmentToUpdate = await this.findByKey(attachmentKey);

    // 2) update attachment
    const updated = await this.attachmentRepository.update(
      attachmentToUpdate.id,
      updateDto,
    );
    if (updated.error)
      throw new InternalServerErrorException(
        `Attachment update error: ${updated.error}`,
      );

    return this.asAttachment(updated.data);
  }

  async delete(attachmentKey: string): Promise<null> {
    const attachmentToDelete = await this.findByKey(attachmentKey);
    if (!attachmentToDelete)
      throw new NotFoundException('Attachment not found');

    const { error: deleteError } = await this.attachmentRepository.delete(
      attachmentToDelete.id,
    );
    if (deleteError) {
      throw new InternalServerErrorException(
        `Attachment deletion error: ${deleteError}`,
      );
    }

    return null;
  }
}
