import { functionName, scheduleOf } from '../functions/declarations';
import { nextCron } from '../functions/cron';
import { randomUUID } from 'node:crypto';
import {
  PUBLICATION_META_KEYS,
  withoutPublicationState,
} from '../common/publish/publication-state';
import { CruxGraphService } from './crux-graph.service';
import {
  Injectable,
  ServiceUnavailableException,
  ConflictException,
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
  protected override readonly protectedMetaKeys = PUBLICATION_META_KEYS;

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

    createCruxDto.meta = withoutPublicationState(createCruxDto.meta);
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
      throw new InternalServerErrorException('Crux creation error', {
        cause: created.error,
      });

    return this.asCrux(created.data);
  }

  async delete(cruxId: string, hard = false): Promise<null> {
    // 1) fetch crux
    const cruxToDelete = await this.findById(cruxId);
    if (!cruxToDelete) throw new NotFoundException('Crux not found');

    if (cruxToDelete.meta?.publishedAt) {
      await this.removePublication(cruxToDelete.id);
    }

    // 2) delete crux
    const { error: deleteError } = await this.cruxRepository.delete(
      cruxToDelete.id,
      undefined,
      hard,
    );

    if (deleteError) {
      throw new InternalServerErrorException('Crux deletion error', {
        cause: deleteError,
      });
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
        (artifact.meta?.publishLayout ||
          crux.meta.publishLayout ||
          this.publishLayout()) === 'bucket-per-crux'
      ) {
        const data = await this.publishStorage.downloadFile(
          artifact.meta?.publishStorageId ||
            crux.meta?.publishStorageId ||
            crux.id,
          path,
        );
        return {
          data,
          filename: artifact.filename,
          mimeType: artifact.mimeType,
        };
      }
      const result = await this.storeService.download({
        namespace:
          process.env.AWS_S3_PUBLISHED_BUCKET || 'crux-garden-published',
        path: `${artifact.meta?.publishStorageId || crux.meta?.publishStorageId || crux.id}/${path}`,
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
    if (process.env.PUBLISH_REVISION_ROUTING !== '1')
      throw new ServiceUnavailableException(
        'Publishing is awaiting the revision-aware origin router. Deploy the router, then enable PUBLISH_REVISION_ROUTING.',
      );
    const crux = await this.findById(cruxId);

    if (crux.meta?.publicationRemoving)
      throw new ConflictException(
        'Finish removing the previous publication before publishing again.',
      );

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

    // A unique location keeps both layouts immutable while a replacement uploads.
    // The public Crux ID remains stable; only the edge's storage pointer changes.
    const storageId = randomUUID();
    const layout = this.publishLayout();
    await this.domainsService.assertPublicationLayout(crux.id, layout);
    const artifactRecords = files.map((file, i) =>
      this.artifactService.describePublishedArtifact(
        crux.id,
        crux.homeId,
        authorId,
        file,
        fileMetas[i] || {},
        storageId,
        layout,
      ),
    );
    const publishFiles = files.map((file, i) => ({
      buffer: file.buffer,
      mimeType: file.mimetype,
      path: fileMetas[i]?.path || file.originalname,
      artifact: artifactRecords[i],
    }));
    const prepared = this.artifactService.preparePublishFiles(
      publishFiles,
      crux.kind,
      crux.id,
    );
    const publishedBytes = prepared.reduce(
      (sum, file) => sum + file.data.length,
      0,
    );
    const now = new Date();
    const schedules = files.flatMap((file, index) => {
      const name = functionName(fileMetas[index]?.path ?? file.originalname);
      const schedule = name ? scheduleOf(file.buffer.toString('utf8')) : null;
      const nextRun = schedule ? nextCron(schedule, now) : null;
      return name && schedule && nextRun ? [{ name, schedule, nextRun }] : [];
    });
    let updated: Awaited<ReturnType<CruxRepository['commitPublication']>>;
    let admissionStarted = false;
    try {
      if (layout === 'bucket-per-crux') {
        await this.publishStorage.ensureBucket(storageId, authorId, crux.id);
        await this.publishStorage.putFiles(storageId, prepared);
      } else {
        await this.artifactService.uploadPreparedPublication(
          prepared,
          storageId,
        );
      }
      admissionStarted = true;
      updated = await this.cruxRepository.commitPublication(
        crux.id,
        authorId,
        crux.meta?.publishedVersion || 0,
        artifactRecords,
        {
          publishedAt: new Date().toISOString(),
          publishedVersion: (crux.meta?.publishedVersion || 0) + 1,
          publishLayout: layout,
          publishStorageId: storageId,
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
        schedules,
      );
      if (updated.error) throw updated.error;
    } catch (cause) {
      // A lost database commit acknowledgement is ambiguous: retain staged bytes once
      // admission starts. Never clean up a location that might now be live.
      // Uploaders drain workers before rejecting, so no late write can recreate a cleaned object.
      if (admissionStarted)
        this.logger.warn('Unconfirmed publication location retained', {
          cruxId: crux.id,
          storageId,
          layout,
        });
      try {
        if (!admissionStarted) {
          if (layout === 'bucket-per-crux')
            await this.publishStorage.deleteBucket(storageId);
          else await this.artifactService.deleteFromStaticBucket(storageId);
        }
      } catch (cleanup) {
        this.logger.error(
          'Uncommitted publication cleanup failed',
          cleanup as Error,
        );
      }
      if (cause instanceof ConflictException) throw cause;
      throw new InternalServerErrorException(
        admissionStarted
          ? 'Could not confirm the publication. Please refresh its status before retrying.'
          : 'Could not upload the publication. The previous publication is unchanged. Please retry.',
        { cause },
      );
    }
    // Once committed, a notification/cache failure cannot turn success into a false refusal.
    void this.notifications
      .afterWrite(authorId, accountId)
      .catch((error) =>
        this.logger.error('Publish notification failed', error),
      );
    void this.domainsService
      .activatePublication(crux.id)
      .catch((error) => this.logger.error('Domain activation pending', error));
    void this.storeService
      .invalidateCache({ paths: [`/${crux.id}/*`] })
      .catch((error) =>
        this.logger.error('CloudFront invalidation failed', error),
      );

    return this.asCrux(updated.data);
  }

  /** Retain the owner record until every external cleanup acknowledges success.
   * Each operation is idempotent so a partial failure can be retried safely.
   * CDN invalidation acknowledges submission; propagation is asynchronous.
   */
  async removePublication(cruxId: string): Promise<void> {
    try {
      const removing =
        await this.cruxRepository.beginPublicationRemoval(cruxId);
      if (removing.error) throw removing.error;
      const crux = this.asCrux(removing.data);
      for (const publication of [
        ...(crux.meta?.retiredPublications || []),
        ...(crux.meta?.publishStorageId
          ? [
              {
                storageId: crux.meta.publishStorageId,
                layout: crux.meta.publishLayout,
              },
            ]
          : []),
      ]) {
        if (publication.layout === 'bucket-per-crux')
          await this.publishStorage.deleteBucket(publication.storageId);
        else
          await this.artifactService.deleteFromStaticBucket(
            publication.storageId,
          );
      }
      await this.artifactService.deleteFromStaticBucket(cruxId);
      await this.publishStorage.deleteBucket(cruxId);
      await this.domainsService.removeAllForCrux(cruxId);
      await this.storeService.invalidateCache({ paths: [`/${cruxId}/*`] });
      await this.usageService.clearStorage(cruxId);
    } catch (cause) {
      throw new InternalServerErrorException(
        'Could not finish removing the published site. Please retry.',
        { cause },
      );
    }
  }

  async unpublishCrux(cruxId: string): Promise<Crux> {
    const crux = await this.findById(cruxId);

    await this.removePublication(crux.id);

    // 3. Hard delete crux and all related entities (artifacts, dimensions, tags)
    const { error: deleteError } = await this.cruxRepository.delete(
      crux.id,
      undefined,
      true,
    );

    if (deleteError) {
      throw new InternalServerErrorException('Unpublish error', {
        cause: deleteError,
      });
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
