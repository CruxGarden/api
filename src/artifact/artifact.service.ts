import {
  Injectable,
  NotFoundException,
  InternalServerErrorException,
  BadRequestException,
} from '@nestjs/common';
import { Knex } from 'knex';
import { toEntityFields } from '../common/helpers/case-helpers';
import { CreateArtifactDto } from './dto/create-artifact.dto';
import { UpdateArtifactDto } from './dto/update-artifact.dto';
import { ArtifactRepository } from './artifact.repository';
import { KeyMaster } from '../common/services/key.master';
import { MAX_ARTIFACT_SIZE } from '../common/types/constants';
import { LoggerService } from '../common/services/logger.service';
import { StoreService } from '../common/services/store.service';
import ArtifactRaw from './entities/artifact-raw.entity';
import Artifact from './entities/artifact.entity';
import { UploadArtifactDto } from './dto/upload-artifact.dto';
import * as mime from 'mime-types';
import { applyInjections } from '../common/publish/publish-injections';

interface UploadedFile {
  fieldname: string;
  originalname: string;
  encoding: string;
  mimetype: string;
  buffer: Buffer;
  size: number;
}

@Injectable()
export class ArtifactService {
  private readonly logger: LoggerService;

  constructor(
    private readonly artifactRepository: ArtifactRepository,
    private readonly keyMaster: KeyMaster,
    private readonly loggerService: LoggerService,
    private readonly storeService: StoreService,
  ) {
    this.logger = this.loggerService.createChildLogger('ArtifactService');
  }

  asArtifact(data: ArtifactRaw): Artifact {
    const entityFields = toEntityFields(data);
    return new Artifact(entityFields);
  }

  asArtifacts(rows: ArtifactRaw[]): Artifact[] {
    return rows.map((data) => this.asArtifact(data));
  }

  findAllQuery(): Knex.QueryBuilder<ArtifactRaw, ArtifactRaw[]> {
    return this.artifactRepository.findAllQuery();
  }

  async findById(id: string): Promise<Artifact> {
    const { data: artifact, error } = await this.artifactRepository.findBy(
      'id',
      id,
    );

    if (error || !artifact) {
      throw new NotFoundException('Artifact not found');
    }

    return this.asArtifact(artifact);
  }

  async findByResource(
    resourceType: string,
    resourceId: string,
  ): Promise<Artifact[]> {
    const { data, error } = await this.artifactRepository.findByResource(
      resourceType,
      resourceId,
    );

    if (error) {
      throw new InternalServerErrorException(
        `Error fetching artifacts: ${error}`,
      );
    }

    return this.asArtifacts(data || []);
  }

  async create(createArtifactDto: CreateArtifactDto): Promise<Artifact> {
    createArtifactDto.id = this.keyMaster.generateId();

    const created = await this.artifactRepository.create(createArtifactDto);
    if (created.error)
      throw new InternalServerErrorException(
        `Artifact creation error: ${created.error}`,
      );

    return this.asArtifact(created.data);
  }

  async update(
    artifactId: string,
    updateDto: UpdateArtifactDto,
  ): Promise<Artifact> {
    // 1) fetch artifact
    const artifactToUpdate = await this.findById(artifactId);

    // 2) update artifact
    const updated = await this.artifactRepository.update(
      artifactToUpdate.id,
      updateDto,
    );
    if (updated.error)
      throw new InternalServerErrorException(
        `Artifact update error: ${updated.error}`,
      );

    return this.asArtifact(updated.data);
  }

  async delete(artifactId: string): Promise<null> {
    const artifactToDelete = await this.findById(artifactId);
    if (!artifactToDelete) throw new NotFoundException('Artifact not found');

    const { error: deleteError } = await this.artifactRepository.delete(
      artifactToDelete.id,
    );
    if (deleteError) {
      throw new InternalServerErrorException(
        `Artifact deletion error: ${deleteError}`,
      );
    }

    return null;
  }

  getStoragePath(artifact: {
    resourceType: string;
    resourceId: string;
    id: string;
    mimeType: string;
  }): string {
    const extension = mime.extension(artifact.mimeType);
    const ext = extension ? `.${extension}` : '';
    return `${artifact.resourceType}/${artifact.resourceId}/${artifact.id}${ext}`;
  }

  validateFile(file: UploadedFile): void {
    if (!file) {
      throw new BadRequestException('File is required');
    }

    if (file.size > MAX_ARTIFACT_SIZE) {
      throw new BadRequestException(
        `File size exceeds maximum allowed size of ${MAX_ARTIFACT_SIZE / 1024 / 1024}MB`,
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
    uploadDto: UploadArtifactDto,
    file: UploadedFile,
  ): Promise<Artifact> {
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

    // Create artifact DTO
    const id = this.keyMaster.generateId();

    const createDto: CreateArtifactDto = {
      id,
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
    const created = await this.artifactRepository.create(createDto);
    if (created.error) {
      // Cleanup storage if database save fails
      try {
        await this.storeService.delete({ path: storagePath });
      } catch (cleanupError) {
        this.logger.error(`Storage cleanup failed: ${cleanupError.message}`);
      }
      throw new InternalServerErrorException(
        `Artifact creation error: ${created.error}`,
      );
    }

    return this.asArtifact(created.data);
  }

  async updateWithFile(
    artifactId: string,
    updateDto: UpdateArtifactDto,
    file?: UploadedFile,
  ): Promise<Artifact> {
    const artifactToUpdate = await this.findById(artifactId);
    const oldStoragePath = this.getStoragePath(artifactToUpdate);

    // If file provided, validate and upload
    if (file) {
      this.validateFile(file);

      // Update file-related fields
      updateDto.encoding = file.encoding || '7bit';
      updateDto.mimeType = file.mimetype;
      updateDto.filename = file.originalname;
      updateDto.size = file.size;

      // Generate new storage path (might be different if mimeType changed)
      const newArtifact = { ...artifactToUpdate, ...updateDto };
      const newStoragePath = this.getStoragePath(newArtifact);

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
    const updated = await this.artifactRepository.update(
      artifactToUpdate.id,
      updateDto,
    );
    if (updated.error) {
      throw new InternalServerErrorException(
        `Artifact update error: ${updated.error}`,
      );
    }

    return this.asArtifact(updated.data);
  }

  async deleteWithFile(artifactId: string): Promise<null> {
    const artifactToDelete = await this.findById(artifactId);
    if (!artifactToDelete) {
      throw new NotFoundException('Artifact not found');
    }

    // Delete from storage
    const storagePath = this.getStoragePath(artifactToDelete);
    try {
      await this.storeService.delete({ path: storagePath });
    } catch (error) {
      this.logger.warn(`Storage deletion failed: ${error.message}`);
      // Continue with database deletion even if storage fails
    }

    // Soft delete from database
    const { error: deleteError } = await this.artifactRepository.delete(
      artifactToDelete.id,
    );
    if (deleteError) {
      throw new InternalServerErrorException(
        `Artifact deletion error: ${deleteError}`,
      );
    }

    return null;
  }

  async findByResourceAndKind(
    resourceType: string,
    resourceId: string,
    kind: string,
  ): Promise<Artifact[]> {
    const { data, error } = await this.artifactRepository.findByResourceAndKind(
      resourceType,
      resourceId,
      kind,
    );

    if (error) {
      throw new InternalServerErrorException(
        `Error fetching artifacts: ${error}`,
      );
    }

    return this.asArtifacts(data || []);
  }

  async copyArtifactToSnapshot(
    source: Artifact,
    cruxId: string,
  ): Promise<Artifact> {
    const newId = this.keyMaster.generateId();

    // Build S3 paths
    const sourcePath = this.getStoragePath(source);
    const destPath = this.getStoragePath({
      resourceType: source.resourceType,
      resourceId: cruxId,
      id: newId,
      mimeType: source.mimeType,
    });

    // Copy S3 file
    await this.storeService.copy({ sourcePath, destPath });

    // Create snapshot artifact record
    const createDto: CreateArtifactDto = {
      id: newId,
      type: source.type,
      kind: 'published-snapshot',
      meta: {
        ...source.meta,
        sourceArtifactId: source.id,
      },
      resourceId: cruxId,
      resourceType: source.resourceType,
      authorId: source.authorId,
      homeId: source.homeId,
      encoding: source.encoding,
      mimeType: source.mimeType,
      filename: source.filename,
      size: source.size,
    };

    const created = await this.artifactRepository.create(createDto);
    if (created.error) {
      // Cleanup S3 if DB fails
      try {
        await this.storeService.delete({ path: destPath });
      } catch (cleanupError) {
        this.logger.error(`Snapshot cleanup failed: ${cleanupError.message}`);
      }
      throw new InternalServerErrorException(
        `Snapshot artifact creation error: ${created.error}`,
      );
    }

    return this.asArtifact(created.data);
  }

  async deleteSnapshotArtifacts(
    resourceType: string,
    resourceId: string,
  ): Promise<void> {
    const snapshots = await this.findByResourceAndKind(
      resourceType,
      resourceId,
      'published-snapshot',
    );

    for (const snapshot of snapshots) {
      await this.deleteWithFile(snapshot.id);
    }
  }

  async publishToStaticBucket(
    artifacts: Artifact[],
    pathPrefix: string,
    cruxKind?: string,
  ): Promise<void> {
    const publishedBucket =
      process.env.AWS_S3_PUBLISHED_BUCKET || 'crux-garden-published';

    await Promise.all(
      artifacts.map(async (artifact) => {
        const virtualPath =
          artifact.meta?.path || artifact.filename || artifact.id;

        const storagePath = this.getStoragePath(artifact);
        let { data } = await this.storeService.download({ path: storagePath });

        // Apply publish injections to HTML files (SPA support, navigation sync, etc.)
        if (artifact.mimeType === 'text/html') {
          const result = applyInjections(data, artifact, artifacts, cruxKind);
          data = result.data;
          if (result.applied.length > 0) {
            this.logger.info(`Publish injections applied to ${virtualPath}`, {
              injections: result.applied,
            });
          }
        }

        const publishedPath = `${pathPrefix}/${virtualPath}`;
        await this.storeService.upload({
          path: publishedPath,
          data,
          namespace: publishedBucket,
          contentType: artifact.mimeType,
        });
      }),
    );
  }

  async deleteFromStaticBucket(pathPrefix: string): Promise<void> {
    const publishedBucket =
      process.env.AWS_S3_PUBLISHED_BUCKET || 'crux-garden-published';

    await this.storeService.deleteByPrefix({
      prefix: `${pathPrefix}/`,
      namespace: publishedBucket,
    });
  }

  getArtifactsByResourceQuery(
    resourceType: string,
    resourceId: string,
  ): Knex.QueryBuilder<ArtifactRaw, ArtifactRaw[]> {
    return this.artifactRepository
      .findAllQuery()
      .where('resource_type', resourceType)
      .where('resource_id', resourceId);
  }

  async downloadArtifact(artifactId: string) {
    const artifact = await this.findById(artifactId);
    const storagePath = this.getStoragePath(artifact);

    try {
      const result = await this.storeService.download({ path: storagePath });
      return {
        data: result.data,
        filename: artifact.filename,
        mimeType: artifact.mimeType,
      };
    } catch (error) {
      this.logger.error(`Storage download failed: ${error.message}`);
      throw new NotFoundException('Artifact file not found in storage');
    }
  }
}
