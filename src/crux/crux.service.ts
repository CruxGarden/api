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
import { DimensionType, ResourceType } from '../common/types/enums';
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

  async findByKey(key: string): Promise<Crux> {
    const { data, error } = await this.cruxRepository.findBy('key', key);

    if (error || !data) {
      throw new NotFoundException('Crux not found');
    }

    return this.asCrux(data);
  }

  async create(createCruxDto: CreateCruxDto): Promise<Crux> {
    createCruxDto.id = this.keyMaster.generateId();
    createCruxDto.key = this.keyMaster.generateKey();

    const created = await this.cruxRepository.create(createCruxDto);
    if (created.error)
      throw new InternalServerErrorException(
        `Crux creation error: ${created.error}`,
      );

    return this.asCrux(created.data);
  }

  async update(cruxKey: string, updateCruxDto: UpdateCruxDto): Promise<Crux> {
    // 1) fetch crux
    const cruxToUpdate = await this.findByKey(cruxKey);

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

  async delete(cruxKey: string): Promise<null> {
    // 1) fetch crux
    const cruxToDelete = await this.findByKey(cruxKey);
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
  ): Knex.QueryBuilder<DimensionRaw, DimensionRaw[]> {
    return this.dimensionService.findBySourceIdAndTypeQuery(
      sourceCruxId,
      dimensionType,
    );
  }

  async createDimension(
    cruxKey: string,
    createDimensionDto: CreateDimensionDto,
  ): Promise<Dimension> {
    const sourceCrux = await this.findByKey(cruxKey);
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

  async getTags(cruxKey: string, filter?: string): Promise<Tag[]> {
    const crux = await this.findByKey(cruxKey);
    return this.tagService.getTags(ResourceType.CRUX, crux.id, filter);
  }

  async syncTags(
    cruxKey: string,
    labels: string[],
    authorId: string,
  ): Promise<Tag[]> {
    const crux = await this.findByKey(cruxKey);
    return this.tagService.syncTags(
      ResourceType.CRUX,
      crux.id,
      labels,
      authorId,
    );
  }

  /* ~crux tags */

  /* crux attachments */

  async getAttachments(cruxKey: string): Promise<Attachment[]> {
    const crux = await this.findByKey(cruxKey);
    return this.attachmentService.findByResource(ResourceType.CRUX, crux.id);
  }

  async createAttachment(
    cruxKey: string,
    uploadDto: UploadAttachmentDto,
    file: any,
    authorId: string,
  ): Promise<Attachment> {
    const crux = await this.findByKey(cruxKey);
    return this.attachmentService.createWithFile(
      ResourceType.CRUX,
      crux.id,
      crux.homeId,
      authorId,
      uploadDto,
      file,
    );
  }

  async downloadAttachment(cruxKey: string, attachmentKey: string) {
    // Verify the attachment belongs to this crux
    const crux = await this.findByKey(cruxKey);
    const attachment = await this.attachmentService.findByKey(attachmentKey);

    if (
      attachment.resourceType !== ResourceType.CRUX ||
      attachment.resourceId !== crux.id
    ) {
      throw new NotFoundException('Attachment not found for this crux');
    }

    return this.attachmentService.downloadAttachment(attachmentKey);
  }

  /* ~crux attachments */
}
