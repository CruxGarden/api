import {
  Injectable,
  NotFoundException,
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

    // 2) update crux
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
    return this.attachmentService.findByResource(ResourceType.CRUX, crux.id);
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

  private applyDefaults(dto: CreateCruxDto): void {
    if (!dto.type) dto.type = CruxType.MARKDOWN;
    if (!dto.status) dto.status = CruxStatus.LIVING;
    if (!dto.visibility) dto.visibility = CruxVisibility.UNLISTED;
  }
}
