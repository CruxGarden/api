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
import { ArtifactService } from '../artifact/artifact.service';
import { StoreService } from '../common/services/store.service';
import Artifact from '../artifact/entities/artifact.entity';
import { UploadArtifactDto } from '../artifact/dto/upload-artifact.dto';

@Injectable()
export class CruxService {
  private readonly logger: LoggerService;

  constructor(
    private readonly cruxRepository: CruxRepository,
    private readonly keyMaster: KeyMaster,
    private readonly loggerService: LoggerService,
    private readonly dimensionService: DimensionService,
    private readonly tagService: TagService,
    private readonly artifactService: ArtifactService,
    private readonly storeService: StoreService,
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

  findAllByAuthorQuery(
    authorId: string,
  ): Knex.QueryBuilder<CruxRaw, CruxRaw[]> {
    return this.cruxRepository.findAllByAuthorQuery(authorId);
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

  async create(createCruxDto: CreateCruxDto, authorId?: string): Promise<Crux> {
    createCruxDto.id = createCruxDto.id || this.keyMaster.generateId();

    this.applyDefaults(createCruxDto);

    // Hard-delete a soft-deleted record with the same ID and same author
    // (e.g. from a previous unpublish) so the INSERT doesn't hit a duplicate PK.
    // Scoped to authorId to avoid clobbering another author's crux.
    if (createCruxDto.id && (authorId || createCruxDto.authorId)) {
      const existing = await this.cruxRepository.findByIdIncludingDeleted(
        createCruxDto.id,
      );
      if (
        existing.data?.deleted &&
        existing.data.author_id === (authorId || createCruxDto.authorId)
      ) {
        await this.cruxRepository.delete(createCruxDto.id, undefined, true);
      }
    }

    // If the same author+slug already exists (stale from a previous publish),
    // hard-delete it so the new crux can take its place.
    const effectiveAuthorId = authorId || createCruxDto.authorId;
    if (effectiveAuthorId && createCruxDto.slug) {
      const existing = await this.cruxRepository.findByAuthorAndSlug(
        effectiveAuthorId,
        createCruxDto.slug,
      );
      if (existing.data) {
        await this.cruxRepository.delete(existing.data.id, undefined, true);
      }
    }

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

  async delete(cruxId: string, hard = false): Promise<null> {
    // 1) fetch crux
    const cruxToDelete = await this.findById(cruxId);
    if (!cruxToDelete) throw new NotFoundException('Crux not found');

    // 2) delete crux
    const { error: deleteError } = await this.cruxRepository.delete(
      cruxToDelete.id,
      undefined,
      hard,
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

  /* crux artifacts */

  async getArtifacts(cruxId: string): Promise<Artifact[]> {
    const crux = await this.findById(cruxId);
    const all = await this.artifactService.findByResource(
      ResourceType.CRUX,
      crux.id,
    );
    // Filter out published snapshots — workspace should only see working files
    return all.filter((a) => a.kind !== 'published-snapshot');
  }

  async createArtifact(
    cruxId: string,
    uploadDto: UploadArtifactDto,
    file: any,
    authorId: string,
  ): Promise<Artifact> {
    const crux = await this.findById(cruxId);
    return this.artifactService.createWithFile(
      ResourceType.CRUX,
      crux.id,
      crux.homeId,
      authorId,
      uploadDto,
      file,
    );
  }

  async downloadArtifact(cruxId: string, artifactId: string) {
    // Verify the artifact belongs to this crux
    const crux = await this.findById(cruxId);
    const artifact = await this.artifactService.findById(artifactId);

    if (
      artifact.resourceType !== ResourceType.CRUX ||
      artifact.resourceId !== crux.id
    ) {
      throw new NotFoundException('Artifact not found for this crux');
    }

    return this.artifactService.downloadArtifact(artifactId);
  }

  /* ~crux artifacts */

  /* crux publishing */

  async publishCrux(
    cruxId: string,
    files: Express.Multer.File[],
    fileMetas: Array<{ path?: string; type?: string; kind?: string }>,
    authorId: string,
  ): Promise<Crux> {
    const crux = await this.findById(cruxId);

    // 1. Replace existing artifact records (working + any old snapshots).
    //    deleteWorkingArtifactsByResource handles missing S3 files gracefully.
    await this.artifactService.deleteWorkingArtifactsByResource(
      ResourceType.CRUX,
      crux.id,
    );
    await this.artifactService.deleteSnapshotArtifacts(
      ResourceType.CRUX,
      crux.id,
    );

    // 2. Create artifact DB records (metadata only — no working S3 copy needed).
    const artifactRecords: Artifact[] = [];
    for (let i = 0; i < files.length; i++) {
      const record = await this.artifactService.createArtifactRecord(
        ResourceType.CRUX,
        crux.id,
        crux.homeId,
        authorId,
        files[i],
        fileMetas[i] || {},
      );
      artifactRecords.push(record);
    }

    // 3. Publish files directly to the published S3 bucket (cruxId only — per-crux subdomain isolation).
    const pathPrefix = crux.id;
    await this.artifactService.deleteFromStaticBucket(pathPrefix);
    await this.artifactService.publishFilesDirectly(
      files.map((file, i) => ({
        buffer: file.buffer,
        mimeType: file.mimetype,
        path: fileMetas[i]?.path || file.originalname,
        artifact: artifactRecords[i],
      })),
      pathPrefix,
      crux.kind,
    );

    // 4. Invalidate CloudFront cache (best-effort, don't block publish)
    this.storeService
      .invalidateCache({ paths: [`/${pathPrefix}/*`] })
      .catch((err) =>
        this.logger.error(`CloudFront invalidation failed: ${err.message}`),
      );

    // 5. Update crux meta with publish info and set visibility to public
    const publishedVersion = (crux.meta?.publishedVersion || 0) + 1;
    const publishedAt = new Date().toISOString();

    const updated = await this.cruxRepository.update(crux.id, {
      meta: { ...crux.meta, publishedAt, publishedVersion },
      visibility: CruxVisibility.PUBLIC,
    });

    if (updated.error) {
      throw new InternalServerErrorException(`Publish error: ${updated.error}`);
    }

    return this.asCrux(updated.data);
  }

  async unpublishCrux(cruxId: string): Promise<Crux> {
    const crux = await this.findById(cruxId);

    // 1. Delete published files from static S3 bucket
    const pathPrefix = crux.id;
    await this.artifactService.deleteFromStaticBucket(pathPrefix);

    // 2. Invalidate CloudFront cache (best-effort)
    this.storeService
      .invalidateCache({ paths: [`/${pathPrefix}/*`] })
      .catch((err) =>
        this.logger.error(`CloudFront invalidation failed: ${err.message}`),
      );

    // 3. Hard delete crux and all related entities (artifacts, dimensions, tags)
    const { error: deleteError } = await this.cruxRepository.delete(
      crux.id,
      undefined,
      true,
    );

    if (deleteError) {
      throw new InternalServerErrorException(`Unpublish error: ${deleteError}`);
    }

    // Return the crux state as it was before deletion (for client-side update)
    return crux;
  }

  async getPublishedArtifacts(cruxId: string): Promise<Artifact[]> {
    const crux = await this.findById(cruxId);

    // If crux has been published, return snapshot artifacts
    if (crux.meta?.publishedAt) {
      const snapshots = await this.artifactService.findByResourceAndKind(
        ResourceType.CRUX,
        crux.id,
        'published-snapshot',
      );
      if (snapshots.length > 0) {
        return snapshots;
      }
    }

    // Fallback: return working artifacts (backward compat for pre-snapshot cruxes)
    return this.artifactService.findByResource(ResourceType.CRUX, crux.id);
  }

  /* ~crux publishing */

  private applyDefaults(dto: CreateCruxDto): void {
    if (!dto.type) dto.type = CruxType.MARKDOWN;
    if (!dto.status) dto.status = CruxStatus.LIVING;
    if (!dto.visibility) dto.visibility = CruxVisibility.UNLISTED;
  }
}
