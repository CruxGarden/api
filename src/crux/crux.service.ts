import {
  Injectable,
  NotFoundException,
  ConflictException,
  InternalServerErrorException,
} from '@nestjs/common';
import { Knex } from 'knex';
import { toEntityFields } from '../common/helpers/case-helpers';
import { CreateCruxDto } from './dto/create-crux.dto';
import { UpdateCruxDto } from './dto/update-crux.dto';
import { CruxRepository } from './crux.repository';
import { KeyMaster } from '../common/services/key.master';
import { LoggerService } from '../common/services/logger.service';
import { DimensionService } from '../dimension/dimension.service';
import CruxRaw from './entities/crux-raw.entity';
import Crux from './entities/crux.entity';
import Dimension from '../dimension/entities/dimension.entity';
import DimensionRaw from '../dimension/entities/dimension-raw.entity';
import {
  CruxStatus,
  CruxType,
  CruxVisibility,
  DimensionType,
  ResourceType,
} from '../common/types/enums';
import { CreateDimensionDto } from '../dimension/dto/create-dimension.dto';
import { UpdateDimensionDto } from '../dimension/dto/update-dimension.dto';
import { TagService } from '../tag/tag.service';
import Tag from '../tag/entities/tag.entity';
import { AttachmentService } from '../attachment/attachment.service';
import Attachment from '../attachment/entities/attachment.entity';
import { UploadAttachmentDto } from '../attachment/dto/upload-attachment.dto';

@Injectable()
export class CruxService {
  // @ts-expect-error - logger
  private readonly logger: LoggerService;

  constructor(
    private readonly cruxRepository: CruxRepository,
    private readonly keyMaster: KeyMaster,
    private readonly loggerService: LoggerService,
    private readonly dimensionService: DimensionService,
    private readonly tagService: TagService,
    private readonly attachmentService: AttachmentService,
  ) {
    this.logger = this.loggerService.createChildLogger('CruxService');
  }

  asCrux(data: CruxRaw): Crux {
    const entityFields = toEntityFields(data);
    return new Crux(entityFields);
  }

  asCruxes(rows: CruxRaw[]): Crux[] {
    return rows.map((data) => this.asCrux(data));
  }

  findAllQuery(): Knex.QueryBuilder<CruxRaw, CruxRaw[]> {
    return this.cruxRepository.findAllQuery();
  }

  findPublicByAuthorQuery(
    authorId: string,
  ): Knex.QueryBuilder<CruxRaw, CruxRaw[]> {
    return this.cruxRepository.findPublicByAuthorQuery(authorId);
  }

  async findById(id: string): Promise<Crux> {
    const { data, error } = await this.cruxRepository.findBy('id', id);

    if (error || !data) {
      throw new NotFoundException('Crux not found');
    }

    return this.asCrux(data);
  }

  async findBySlug(slug: string): Promise<Crux> {
    const { data, error } = await this.cruxRepository.findBy('slug', slug);

    if (error || !data) {
      throw new NotFoundException('Crux not found');
    }

    return this.asCrux(data);
  }

  async findByAuthorAndSlug(authorId: string, slug: string): Promise<Crux> {
    const { data, error } = await this.cruxRepository.findByAuthorAndSlug(
      authorId,
      slug,
    );

    if (error || !data) {
      throw new NotFoundException('Crux not found');
    }

    return this.asCrux(data);
  }

  async findByIdentifier(identifier: string): Promise<Crux> {
    // If it looks like a UUID, search by ID
    const uuidPattern =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (uuidPattern.test(identifier)) {
      return this.findById(identifier);
    }

    // Otherwise, treat it as a slug
    return this.findBySlug(identifier);
  }

  async create(createCruxDto: CreateCruxDto): Promise<Crux> {
    createCruxDto.id = this.keyMaster.generateId();

    this.applyDefaults(createCruxDto);

    const created = await this.cruxRepository.create(createCruxDto);
    if (created.error)
      throw new InternalServerErrorException(
        `Crux creation error: ${created.error}`,
      );

    return this.asCrux(created.data);
  }

  async update(cruxId: string, updateCruxDto: UpdateCruxDto): Promise<Crux> {
    // 1) fetch crux
    const cruxToUpdate = await this.findById(cruxId);

    // 2) check slug uniqueness (per author, excluding this crux)
    if (updateCruxDto.slug && updateCruxDto.slug !== cruxToUpdate.slug) {
      const existing = await this.cruxRepository.findByAuthorAndSlug(
        cruxToUpdate.authorId,
        updateCruxDto.slug,
      );
      if (existing.data) {
        throw new ConflictException(
          `Slug "${updateCruxDto.slug}" is already in use`,
        );
      }
    }

    // 3) update crux
    const updated = await this.cruxRepository.update(
      cruxToUpdate.id,
      updateCruxDto,
    );
    if (updated.error) {
      throw new InternalServerErrorException(
        `Crux update error: ${updated.error}`,
      );
    }

    return this.asCrux(updated.data);
  }

  async delete(cruxId: string): Promise<null> {
    // 1) fetch crux
    const cruxToDelete = await this.findById(cruxId);
    if (!cruxToDelete) throw new NotFoundException('Crux not found');

    // 2) delete crux
    const { error: deleteError } = await this.cruxRepository.delete(
      cruxToDelete.id,
    );

    if (deleteError) {
      throw new InternalServerErrorException(
        `Crux deletion error: ${deleteError}`,
      );
    }

    return null;
  }

  /* crux dimensions */

  getDimensionsQuery(
    sourceCruxId: string,
    dimensionType?: DimensionType,
    embedSource = false,
    embedTarget = true,
  ): Knex.QueryBuilder<DimensionRaw, DimensionRaw[]> {
    return this.dimensionService.findBySourceIdAndTypeQuery(
      sourceCruxId,
      dimensionType,
      embedSource,
      embedTarget,
    );
  }

  async createDimension(
    cruxId: string,
    createDimensionDto: CreateDimensionDto,
  ): Promise<Dimension> {
    const sourceCrux = await this.findById(cruxId);
    if (!sourceCrux) {
      throw new NotFoundException('Crux not found');
    }
    createDimensionDto.sourceId = sourceCrux.id;
    return this.dimensionService.create(createDimensionDto);
  }

  async updateDimension(
    dimensionId: string,
    updateDimensionDto: UpdateDimensionDto,
  ): Promise<Dimension> {
    return this.dimensionService.update(dimensionId, updateDimensionDto);
  }

  /* ~crux dimensions */

  /* crux tags */

  async getTags(cruxId: string, filter?: string): Promise<Tag[]> {
    const crux = await this.findById(cruxId);
    return this.tagService.getTags(ResourceType.CRUX, crux.id, filter);
  }

  async syncTags(
    cruxId: string,
    labels: string[],
    authorId: string,
  ): Promise<Tag[]> {
    const crux = await this.findById(cruxId);
    return this.tagService.syncTags(
      ResourceType.CRUX,
      crux.id,
      labels,
      authorId,
    );
  }

  /* ~crux tags */

  /* crux attachments */

  async getAttachments(cruxId: string): Promise<Attachment[]> {
    const crux = await this.findById(cruxId);
    const all = await this.attachmentService.findByResource(
      ResourceType.CRUX,
      crux.id,
    );
    // Filter out published snapshots — workspace should only see working files
    return all.filter((a) => a.kind !== 'published-snapshot');
  }

  async createAttachment(
    cruxId: string,
    uploadDto: UploadAttachmentDto,
    file: any,
    authorId: string,
  ): Promise<Attachment> {
    const crux = await this.findById(cruxId);
    return this.attachmentService.createWithFile(
      ResourceType.CRUX,
      crux.id,
      crux.homeId,
      authorId,
      uploadDto,
      file,
    );
  }

  async downloadAttachment(cruxId: string, attachmentId: string) {
    // Verify the attachment belongs to this crux
    const crux = await this.findById(cruxId);
    const attachment = await this.attachmentService.findById(attachmentId);

    if (
      attachment.resourceType !== ResourceType.CRUX ||
      attachment.resourceId !== crux.id
    ) {
      throw new NotFoundException('Attachment not found for this crux');
    }

    return this.attachmentService.downloadAttachment(attachmentId);
  }

  /* ~crux attachments */

  /* crux publishing */

  async publishCrux(cruxId: string): Promise<Crux> {
    const crux = await this.findById(cruxId);

    // 1. Clean up any existing snapshot attachments
    await this.attachmentService.deleteSnapshotAttachments(
      ResourceType.CRUX,
      crux.id,
    );

    // 2. Get current working attachments (exclude old snapshots)
    const all = await this.attachmentService.findByResource(
      ResourceType.CRUX,
      crux.id,
    );
    const workingAttachments = all.filter(
      (a) => a.kind !== 'published-snapshot',
    );

    // 3. Copy each working attachment to a snapshot
    for (const attachment of workingAttachments) {
      await this.attachmentService.copyAttachmentToSnapshot(
        attachment,
        crux.id,
      );
    }

    // 4. Update crux meta with publish info
    const publishedVersion = (crux.meta?.publishedVersion || 0) + 1;
    const publishedAt = new Date().toISOString();

    const updatedMeta = {
      ...crux.meta,
      publishedAt,
      publishedVersion,
    };

    // 5. Set visibility to public and update meta
    const updated = await this.cruxRepository.update(crux.id, {
      meta: updatedMeta,
      visibility: CruxVisibility.PUBLIC,
    });

    if (updated.error) {
      throw new InternalServerErrorException(`Publish error: ${updated.error}`);
    }

    return this.asCrux(updated.data);
  }

  async unpublishCrux(cruxId: string): Promise<Crux> {
    const crux = await this.findById(cruxId);

    // Clean up snapshot attachments
    await this.attachmentService.deleteSnapshotAttachments(
      ResourceType.CRUX,
      crux.id,
    );

    // Remove publish metadata and set to private
    const updatedMeta = { ...crux.meta };
    delete updatedMeta.publishedAt;
    delete updatedMeta.publishedVersion;

    const updated = await this.cruxRepository.update(crux.id, {
      meta: updatedMeta,
      visibility: CruxVisibility.PRIVATE,
    });

    if (updated.error) {
      throw new InternalServerErrorException(
        `Unpublish error: ${updated.error}`,
      );
    }

    return this.asCrux(updated.data);
  }

  async getPublishedAttachments(cruxId: string): Promise<Attachment[]> {
    const crux = await this.findById(cruxId);

    // If crux has been published, return snapshot attachments
    if (crux.meta?.publishedAt) {
      const snapshots = await this.attachmentService.findByResourceAndKind(
        ResourceType.CRUX,
        crux.id,
        'published-snapshot',
      );
      if (snapshots.length > 0) {
        return snapshots;
      }
    }

    // Fallback: return working attachments (backward compat for pre-snapshot cruxes)
    return this.attachmentService.findByResource(ResourceType.CRUX, crux.id);
  }

  /* ~crux publishing */

  private applyDefaults(dto: CreateCruxDto): void {
    if (!dto.type) dto.type = CruxType.MARKDOWN;
    if (!dto.status) dto.status = CruxStatus.LIVING;
    if (!dto.visibility) dto.visibility = CruxVisibility.UNLISTED;
  }
}
