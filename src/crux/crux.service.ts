import { CruxGraphService } from './crux-graph.service';
import {
  Injectable,
  BadRequestException,
  PayloadTooLargeException,
  NotFoundException,
  InternalServerErrorException,
} from '@nestjs/common';
import { CreateCruxDto } from './dto/create-crux.dto';
import { CruxRepository } from './crux.repository';
import { KeyMaster } from '../common/services/key.master';
import { LoggerService } from '../common/services/logger.service';
import { DimensionService } from '../dimension/dimension.service';
import Crux from './entities/crux.entity';
import {
  CruxStatus,
  CruxType,
  CruxVisibility,
  ResourceType,
} from '../common/types/enums';
import { TagService } from '../tag/tag.service';
import Tag from '../tag/entities/tag.entity';
import { ArtifactService } from '../artifact/artifact.service';
import { StoreService } from '../common/services/store.service';
import { PublishStorageService } from '../common/services/publish-storage.service';
import { UsageService } from '../usage/usage.service';
import { LimitsService } from '../usage/limits.service';
import { NotificationsService } from '../usage/notifications.service';
import { DomainsService } from '../domains/domains.service';
import Artifact from '../artifact/entities/artifact.entity';
import { UploadArtifactDto } from '../artifact/dto/upload-artifact.dto';
import { MAX_ARTIFACT_SIZE } from '../common/types/constants';
import {
  inspectToolPackage,
  TOOL_PACKAGE_PATH,
} from '../common/publish/tool-package';

@Injectable()
export class CruxService extends CruxGraphService {
  private readonly logger: LoggerService;

  constructor(
    cruxRepository: CruxRepository,
    keyMaster: KeyMaster,
    private readonly loggerService: LoggerService,
    dimensionService: DimensionService,
    private readonly tagService: TagService,
    private readonly artifactService: ArtifactService,
    private readonly storeService: StoreService,
    private readonly publishStorage: PublishStorageService,
    private readonly usageService: UsageService,
    private readonly limits: LimitsService,
    private readonly notifications: NotificationsService,
    private readonly domainsService: DomainsService,
  ) {
    super(cruxRepository, keyMaster, dimensionService);
    this.logger = this.loggerService.createChildLogger('CruxService');
  }

  /** ADR 0011: `bucket-per-crux` once the origin router is deployed; `shared` is the legacy layout. */
  private publishLayout(): 'shared' | 'bucket-per-crux' {
    return process.env.PUBLISH_LAYOUT === 'bucket-per-crux'
      ? 'bucket-per-crux'
      : 'shared';
  }

  /** Hosted publication ingestion retains its existing explicit replacement policy. */
  override async create(
    createCruxDto: CreateCruxDto,
    authorId?: string,
  ): Promise<Crux> {
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

  async delete(cruxId: string, hard = false): Promise<null> {
    // 1) fetch crux
    const cruxToDelete = await this.findById(cruxId);
    if (!cruxToDelete) throw new NotFoundException('Crux not found');

    // 1b) a deleted crux must not stay live, billed, or reachable by a custom domain
    if (cruxToDelete.meta?.published) {
      await this.artifactService
        .deleteFromStaticBucket(cruxToDelete.id)
        .catch((err: Error) =>
          this.logger.error(
            `static cleanup failed for ${cruxId}: ${err.message}`,
          ),
        );
      await this.publishStorage
        .deleteBucket(cruxToDelete.id)
        .catch((err: Error) =>
          this.logger.error(
            `bucket cleanup failed for ${cruxId}: ${err.message}`,
          ),
        );
      await this.usageService.clearStorage(cruxToDelete.id);
      await this.domainsService.removeAllForCrux(cruxToDelete.id);
    }

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

    const path = (artifact.meta as { path?: string } | null)?.path;
    const published = async () => {
      if (!path)
        throw new NotFoundException('Published artifact path is missing');
      if (
        (crux.meta.publishLayout || this.publishLayout()) === 'bucket-per-crux'
      ) {
        const data = await this.publishStorage.downloadFile(crux.id, path);
        return {
          data,
          filename: artifact.filename,
          mimeType: artifact.mimeType,
        };
      }
      const result = await this.storeService.download({
        namespace:
          process.env.AWS_S3_PUBLISHED_BUCKET || 'crux-garden-published',
        path: `${crux.id}/${path}`,
      });
      return {
        data: result.data,
        filename: artifact.filename,
        mimeType: artifact.mimeType,
      };
    };
    // Tool packages never have a separate working-file object. Go straight
    // to the published archive rather than paying for a guaranteed S3 miss.
    if (
      crux.kind === 'tool' &&
      crux.meta?.toolPackage?.artifactId === artifactId &&
      crux.meta?.publishedAt &&
      path
    )
      return published();
    try {
      return await this.artifactService.downloadArtifact(artifactId);
    } catch (error) {
      // Older publications and ordinary projects may also live only in the
      // published store. Preserve their working-copy-first fallback.
      if (!crux.meta?.publishedAt || !path) throw error;
      return published();
    }
  }

  /* ~crux artifacts */

  /* crux publishing */

  async publishCrux(
    cruxId: string,
    files: Express.Multer.File[],
    fileMetas: Array<{ path?: string; type?: string; kind?: string }>,
    authorId: string,
    accountId?: string,
  ): Promise<Crux> {
    const crux = await this.findById(cruxId);

    // Validate the one tool-version entity before replacing an existing publication.
    let toolPackage: Awaited<ReturnType<typeof inspectToolPackage>> | undefined;
    if (crux.kind === 'tool') {
      if (files.length !== 1 || fileMetas[0]?.path !== TOOL_PACKAGE_PATH)
        throw new BadRequestException(
          'Publish a Crux Tool as one package. Update Crux Garden and try again.',
        );
      toolPackage = await inspectToolPackage(
        files[0].buffer,
        crux.meta?.template,
      );
      files[0].mimetype = 'application/zip';
      files[0].originalname = 'tool-package.zip';
      fileMetas = [
        { path: TOOL_PACKAGE_PATH, type: 'artifact', kind: 'tool-package' },
      ];
    } else if (files.some((file) => file.size > MAX_ARTIFACT_SIZE)) {
      throw new PayloadTooLargeException(
        'Individual files must be 250MB or smaller.',
      );
    }

    // 0. Plan limits (grace-first): refuse only past 2× the plan's storage.
    const incoming = files.reduce(
      (sum, f) => sum + (f.size ?? f.buffer?.length ?? 0),
      0,
    );
    const previous = await this.usageService.forCrux(crux.id).catch(() => null);
    await this.limits.assertStorage(
      authorId,
      accountId,
      incoming,
      previous?.storageBytes ?? 0,
      'publish',
    );

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

    // 3. Publish the files.
    const publishFiles = files.map((file, i) => ({
      buffer: file.buffer,
      mimeType: file.mimetype,
      path: fileMetas[i]?.path || file.originalname,
      artifact: artifactRecords[i],
    }));
    const pathPrefix = crux.id;
    let storedBytes: number | null = null;
    if (this.publishLayout() === 'bucket-per-crux') {
      // ADR 0011: the crux's own website bucket; HTML has short cache, so no invalidation
      await this.publishStorage.ensureBucket(crux.id, authorId);
      const put = await this.publishStorage.putFiles(
        crux.id,
        this.artifactService.preparePublishFiles(
          publishFiles,
          crux.kind,
          crux.id,
        ),
      );
      storedBytes = put.bytes; // exact: what actually sits in the bucket, injections included
      // Custom domains cache through their tenants — drop what they hold (best effort)
      void this.domainsService.invalidateForCrux(crux.id);
    } else {
      await this.artifactService.deleteFromStaticBucket(pathPrefix);
      await this.artifactService.publishFilesDirectly(
        publishFiles,
        pathPrefix,
        crux.kind,
        crux.id,
      );
      // 4. Invalidate CloudFront cache (best-effort, don't block publish)
      this.storeService
        .invalidateCache({ paths: [`/${pathPrefix}/*`] })
        .catch((err) =>
          this.logger.error(`CloudFront invalidation failed: ${err.message}`),
        );
    }

    // Storage usage is exact at publish time (ADR 0011 §3)
    const publishedBytes =
      storedBytes ??
      files.reduce((sum, f) => sum + (f.size ?? f.buffer?.length ?? 0), 0);
    await this.usageService.recordStorage(
      crux.id,
      authorId,
      publishedBytes,
      files.length,
    );
    void this.notifications.afterWrite(authorId, accountId);

    // 5. Update crux meta with publish info and set visibility to public
    const publishedVersion = (crux.meta?.publishedVersion || 0) + 1;
    const publishedAt = new Date().toISOString();

    const updated = await this.cruxRepository.update(crux.id, {
      meta: {
        ...crux.meta,
        publishedAt,
        publishedVersion,
        // where the files live — the origin router asks (ADR 0011 migration)
        publishLayout: this.publishLayout(),
        // What the site weighs, so Explore can say what an install carries.
        publishedBytes,
        ...(toolPackage
          ? {
              toolPackage: {
                ...toolPackage,
                artifactId: artifactRecords[0].id,
              },
            }
          : {}),
      },
      visibility: CruxVisibility.PUBLIC,
    });

    if (updated.error) {
      throw new InternalServerErrorException(`Publish error: ${updated.error}`);
    }

    return this.asCrux(updated.data);
  }

  async unpublishCrux(cruxId: string): Promise<Crux> {
    const crux = await this.findById(cruxId);

    // 1. Delete published files — both layouts, so a crux published under the
    //    legacy prefix and republished into its own bucket leaves nothing behind.
    const pathPrefix = crux.id;
    await this.artifactService.deleteFromStaticBucket(pathPrefix);
    await this.publishStorage.deleteBucket(crux.id);

    // 2. Invalidate CloudFront cache (best-effort, legacy layout)
    this.storeService
      .invalidateCache({ paths: [`/${pathPrefix}/*`] })
      .catch((err) =>
        this.logger.error(`CloudFront invalidation failed: ${err.message}`),
      );

    // Usage and custom domains go with it
    await this.usageService.clearStorage(crux.id);
    await this.domainsService.removeAllForCrux(crux.id);

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
    // Workspace cruxes keep their content in artifacts, not in `data` — the
    // column is NOT NULL, so an absent/empty value becomes an empty string.
    if (dto.data == null) dto.data = '';
    if (!dto.type) dto.type = CruxType.MARKDOWN;
    if (!dto.status) dto.status = CruxStatus.LIVING;
    if (!dto.visibility) dto.visibility = CruxVisibility.UNLISTED;
  }
}
