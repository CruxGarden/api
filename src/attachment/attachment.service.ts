import {
  Injectable,
  NotFoundException,
  InternalServerErrorException,
  BadRequestException,
} from '@nestjs/common';
import { Knex } from 'knex';
import { toEntityFields } from '../common/helpers/case-helpers';
import { CreateAttachmentDto } from './dto/create-attachment.dto';
import { UpdateAttachmentDto } from './dto/update-attachment.dto';
import { AttachmentRepository } from './attachment.repository';
import { KeyMaster } from '../common/services/key.master';
import { MAX_ATTACHMENT_SIZE } from '../common/types/constants';
import { LoggerService } from '../common/services/logger.service';
import { StoreService } from '../common/services/store.service';
import AttachmentRaw from './entities/attachment-raw.entity';
import Attachment from './entities/attachment.entity';
import { UploadAttachmentDto } from './dto/upload-attachment.dto';
import * as mime from 'mime-types';

interface UploadedFile {
  fieldname: string;
  originalname: string;
  encoding: string;
  mimetype: string;
  buffer: Buffer;
  size: number;
}

@Injectable()
export class AttachmentService {
  private readonly logger: LoggerService;

  constructor(
    private readonly attachmentRepository: AttachmentRepository,
    private readonly keyMaster: KeyMaster,
    private readonly loggerService: LoggerService,
    private readonly storeService: StoreService,
  ) {
    this.logger = this.loggerService.createChildLogger('AttachmentService');
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

  getStoragePath(attachment: {
    resourceType: string;
    resourceId: string;
    id: string;
    mimeType: string;
  }): string {
    const extension = mime.extension(attachment.mimeType);
    const ext = extension ? `.${extension}` : '';
    return `${attachment.resourceType}/${attachment.resourceId}/${attachment.id}${ext}`;
  }

  validateFile(file: UploadedFile): void {
    if (!file) {
      throw new BadRequestException('File is required');
    }

    if (file.size > MAX_ATTACHMENT_SIZE) {
      throw new BadRequestException(
        `File size exceeds maximum allowed size of ${MAX_ATTACHMENT_SIZE / 1024 / 1024}MB`,
      );
    }

    if (!file.mimetype) {
      throw new BadRequestException('File MIME type could not be determined');
    }
  }

  async createWithFile(
    resourceType: string,
    resourceId: string,
    homeId: string,
    authorId: string,
    uploadDto: UploadAttachmentDto,
    file: UploadedFile,
  ): Promise<Attachment> {
    this.validateFile(file);

    // Parse meta if provided as JSON string
    let meta = uploadDto.meta;
    if (typeof uploadDto.meta === 'string') {
      try {
        meta = JSON.parse(uploadDto.meta);
      } catch {
        throw new BadRequestException('Invalid JSON in meta field');
      }
    }

    // Create attachment DTO
    const id = this.keyMaster.generateId();
    const key = this.keyMaster.generateKey();

    const createDto: CreateAttachmentDto = {
      id,
      key,
      type: uploadDto.type,
      kind: uploadDto.kind,
      meta,
      resourceId,
      resourceType,
      authorId,
      homeId,
      encoding: file.encoding || '7bit',
      mimeType: file.mimetype,
      filename: file.originalname,
      size: file.size,
    };

    // Generate storage path
    const storagePath = this.getStoragePath({
      resourceType,
      resourceId,
      id,
      mimeType: file.mimetype,
    });

    // Upload to storage
    try {
      await this.storeService.upload({
        path: storagePath,
        data: file.buffer,
      });
    } catch (error) {
      this.logger.error(`Storage upload failed: ${error.message}`);
      throw new InternalServerErrorException('File upload failed');
    }

    // Save to database
    const created = await this.attachmentRepository.create(createDto);
    if (created.error) {
      // Cleanup storage if database save fails
      try {
        await this.storeService.delete({ path: storagePath });
      } catch (cleanupError) {
        this.logger.error(`Storage cleanup failed: ${cleanupError.message}`);
      }
      throw new InternalServerErrorException(
        `Attachment creation error: ${created.error}`,
      );
    }

    return this.asAttachment(created.data);
  }

  async updateWithFile(
    attachmentKey: string,
    updateDto: UpdateAttachmentDto,
    file?: UploadedFile,
  ): Promise<Attachment> {
    const attachmentToUpdate = await this.findByKey(attachmentKey);
    const oldStoragePath = this.getStoragePath(attachmentToUpdate);

    // If file provided, validate and upload
    if (file) {
      this.validateFile(file);

      // Update file-related fields
      updateDto.encoding = file.encoding || '7bit';
      updateDto.mimeType = file.mimetype;
      updateDto.filename = file.originalname;
      updateDto.size = file.size;

      // Generate new storage path (might be different if mimeType changed)
      const newAttachment = { ...attachmentToUpdate, ...updateDto };
      const newStoragePath = this.getStoragePath(newAttachment);

      // Upload new file
      try {
        await this.storeService.upload({
          path: newStoragePath,
          data: file.buffer,
        });

        // Delete old file if path changed
        if (oldStoragePath !== newStoragePath) {
          try {
            await this.storeService.delete({ path: oldStoragePath });
          } catch (deleteError) {
            this.logger.warn(
              `Failed to delete old storage file: ${deleteError.message}`,
            );
          }
        }
      } catch (error) {
        this.logger.error(`Storage upload failed: ${error.message}`);
        throw new InternalServerErrorException('File upload failed');
      }
    }

    // Update database
    const updated = await this.attachmentRepository.update(
      attachmentToUpdate.id,
      updateDto,
    );
    if (updated.error) {
      throw new InternalServerErrorException(
        `Attachment update error: ${updated.error}`,
      );
    }

    return this.asAttachment(updated.data);
  }

  async deleteWithFile(attachmentKey: string): Promise<null> {
    const attachmentToDelete = await this.findByKey(attachmentKey);
    if (!attachmentToDelete) {
      throw new NotFoundException('Attachment not found');
    }

    // Delete from storage
    const storagePath = this.getStoragePath(attachmentToDelete);
    try {
      await this.storeService.delete({ path: storagePath });
    } catch (error) {
      this.logger.warn(`Storage deletion failed: ${error.message}`);
      // Continue with database deletion even if storage fails
    }

    // Soft delete from database
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

  getAttachmentsByResourceQuery(
    resourceType: string,
    resourceId: string,
  ): Knex.QueryBuilder<AttachmentRaw, AttachmentRaw[]> {
    return this.attachmentRepository
      .findAllQuery()
      .where('resource_type', resourceType)
      .where('resource_id', resourceId);
  }

  async downloadAttachment(attachmentKey: string) {
    const attachment = await this.findByKey(attachmentKey);
    const storagePath = this.getStoragePath(attachment);

    try {
      const result = await this.storeService.download({ path: storagePath });
      return {
        data: result.data,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
      };
    } catch (error) {
      this.logger.error(`Storage download failed: ${error.message}`);
      throw new NotFoundException('Attachment file not found in storage');
    }
  }
}
