import { Injectable } from '@nestjs/common';
import { Knex } from 'knex';
import { toTableFields } from '../common/helpers/case-helpers';
import { DbService } from '../common/services/db.service';
import { LoggerService } from '../common/services/logger.service';
import { RepositoryResponse } from '../common/types/interfaces';
import { success, failure } from '../common/helpers/repository-helpers';
import ArtifactRaw from './entities/artifact-raw.entity';
import { CreateArtifactDto } from './dto/create-artifact.dto';
import { UpdateArtifactDto } from './dto/update-artifact.dto';

@Injectable()
export class ArtifactRepository {
  // @ts-expect-error - logger
  private readonly logger: LoggerService;

  constructor(
    private readonly dbService: DbService,
    private readonly loggerService: LoggerService,
  ) {
    this.logger = this.loggerService.createChildLogger('ArtifactRepository');
  }

  private static readonly TABLE_NAME = 'artifacts';
  private static readonly BASE_SELECT = '*';

  findAllQuery(): Knex.QueryBuilder<ArtifactRaw, ArtifactRaw[]> {
    return this.dbService
      .query()
      .from<ArtifactRaw>(ArtifactRepository.TABLE_NAME)
      .select<ArtifactRaw[]>(ArtifactRepository.BASE_SELECT)
      .whereNull('deleted')
      .orderBy('created', 'desc') as Knex.QueryBuilder<
      ArtifactRaw,
      ArtifactRaw[]
    >;
  }

  async findBy(
    fieldName: string,
    fieldValue: string,
  ): Promise<RepositoryResponse<ArtifactRaw>> {
    try {
      const data = await this.dbService
        .query()
        .from<ArtifactRaw>(ArtifactRepository.TABLE_NAME)
        .select(ArtifactRepository.BASE_SELECT)
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
  ): Promise<RepositoryResponse<ArtifactRaw[]>> {
    try {
      const data = await this.dbService
        .query()
        .from<ArtifactRaw>(ArtifactRepository.TABLE_NAME)
        .select(ArtifactRepository.BASE_SELECT)
        .where('resource_type', resourceType)
        .where('resource_id', resourceId)
        .whereNull('deleted')
        .orderBy('created', 'desc');

      return success(data);
    } catch (error) {
      return failure(error);
    }
  }

  async findByResourceAndKind(
    resourceType: string,
    resourceId: string,
    kind: string,
  ): Promise<RepositoryResponse<ArtifactRaw[]>> {
    try {
      const data = await this.dbService
        .query()
        .from<ArtifactRaw>(ArtifactRepository.TABLE_NAME)
        .select(ArtifactRepository.BASE_SELECT)
        .where('resource_type', resourceType)
        .where('resource_id', resourceId)
        .where('kind', kind)
        .whereNull('deleted')
        .orderBy('created', 'desc');

      return success(data);
    } catch (error) {
      return failure(error);
    }
  }

  async create(
    createData: CreateArtifactDto,
  ): Promise<RepositoryResponse<ArtifactRaw>> {
    try {
      const tableFields = toTableFields(createData);

      await this.dbService
        .query()
        .from<ArtifactRaw>(ArtifactRepository.TABLE_NAME)
        .insert({
          ...tableFields,
          created: new Date(),
          updated: new Date(),
        });

      const created = await this.dbService
        .query()
        .from<ArtifactRaw>(ArtifactRepository.TABLE_NAME)
        .select(ArtifactRepository.BASE_SELECT)
        .where('id', createData.id)
        .first();

      return success(created);
    } catch (error) {
      return failure(error);
    }
  }

  async update(
    artifactId: string,
    updateData: UpdateArtifactDto,
  ): Promise<RepositoryResponse<ArtifactRaw>> {
    try {
      const tableFields = toTableFields(updateData);

      await this.dbService
        .query()
        .from<ArtifactRaw>(ArtifactRepository.TABLE_NAME)
        .where('id', artifactId)
        .update({
          ...tableFields,
          updated: new Date(),
        });

      const updated = await this.dbService
        .query()
        .from<ArtifactRaw>(ArtifactRepository.TABLE_NAME)
        .select(ArtifactRepository.BASE_SELECT)
        .where('id', artifactId)
        .first();

      return success(updated);
    } catch (error) {
      return failure(error);
    }
  }

  async delete(artifactId: string): Promise<RepositoryResponse<void>> {
    try {
      await this.dbService
        .query()
        .from<ArtifactRaw>(ArtifactRepository.TABLE_NAME)
        .where('id', artifactId)
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
