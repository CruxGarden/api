import { replaceFunctionSchedules } from '../functions/functions.repository';
import { Injectable, ConflictException } from '@nestjs/common';
import { Knex } from 'knex';
import { toTableFields } from '../common/helpers/case-helpers';
import { DbService } from '../common/services/db.service';
import { LoggerService } from '../common/services/logger.service';
import { RepositoryResponse } from '../common/types/interfaces';
import { success, failure } from '../common/helpers/repository-helpers';
import CruxRaw from './entities/crux-raw.entity';
import TakedownRaw from './entities/takedown-raw.entity';
import { CreateCruxDto } from './dto/create-crux.dto';
import { UpdateCruxDto } from './dto/update-crux.dto';
import Artifact from '../artifact/entities/artifact.entity';
import ArtifactRaw from '../artifact/entities/artifact-raw.entity';

@Injectable()
export class CruxRepository {
  // @ts-expect-error - logger
  private readonly logger: LoggerService;

  constructor(
    private readonly dbService: DbService,
    private readonly loggerService: LoggerService,
  ) {
    this.logger = this.loggerService.createChildLogger('CruxRepository');
  }

  private static readonly TABLE_NAME = 'cruxes';
  private static readonly BASE_SELECT = '*';
  private static readonly TAKEDOWNS_TABLE = 'takedowns';

  findAllByAuthorQuery(
    authorId: string,
  ): Knex.QueryBuilder<CruxRaw, CruxRaw[]> {
    return this.dbService
      .query()
      .from<CruxRaw>(CruxRepository.TABLE_NAME)
      .select<CruxRaw[]>(CruxRepository.BASE_SELECT)
      .where('author_id', authorId)
      .whereNull('deleted')
      .orderBy('created', 'desc') as Knex.QueryBuilder<CruxRaw, CruxRaw[]>;
  }

  findPublicByAuthorQuery(
    authorId: string,
    kind?: 'tool' | 'mood' | 'creations',
  ): Knex.QueryBuilder<CruxRaw, CruxRaw[]> {
    const query = this.dbService
      .query()
      .from<CruxRaw>(CruxRepository.TABLE_NAME)
      .select<CruxRaw[]>(CruxRepository.BASE_SELECT)
      .where('author_id', authorId)
      .where('visibility', 'public')
      .whereNull('deleted')
      .orderBy('created', 'desc') as Knex.QueryBuilder<CruxRaw, CruxRaw[]>;
    if (kind === 'creations')
      query.where((q) =>
        q.whereNull('kind').orWhereNotIn('kind', ['tool', 'mood']),
      );
    else if (kind) query.where('kind', kind);
    // ADR 0084: a link-only Mood (not Discoverable) is reachable by its
    // address but is not listed on the author's public garden.
    query.where((q) =>
      q
        .whereNull('kind')
        .orWhereNot('kind', 'mood')
        .orWhere('discoverable', true),
    );
    return query;
  }

  /** A live author's username, for a published Tool's publisher line. */
  async findAuthorUsername(
    authorId: string,
  ): Promise<RepositoryResponse<string | undefined>> {
    try {
      const row = await this.dbService
        .query()
        .from('authors')
        .select('username')
        .where('id', authorId)
        .whereNull('deleted')
        .first();
      return success(row?.username as string | undefined);
    } catch (error) {
      return failure(error);
    }
  }

  async findBy(
    fieldName: string,
    fieldValue: string,
  ): Promise<RepositoryResponse<CruxRaw>> {
    try {
      const data = await this.dbService
        .query()
        .from<CruxRaw>(CruxRepository.TABLE_NAME)
        .select(CruxRepository.BASE_SELECT)
        .where(fieldName, fieldValue)
        .whereNull('deleted')
        .first();

      return success(data);
    } catch (error) {
      return failure(error);
    }
  }

  async findByIdIncludingDeleted(
    id: string,
  ): Promise<RepositoryResponse<CruxRaw>> {
    try {
      const data = await this.dbService
        .query()
        .from<CruxRaw>(CruxRepository.TABLE_NAME)
        .select(CruxRepository.BASE_SELECT)
        .where('id', id)
        .first();

      return success(data);
    } catch (error) {
      return failure(error);
    }
  }

  async findByAuthorAndSlug(
    authorId: string,
    slug: string,
  ): Promise<RepositoryResponse<CruxRaw>> {
    try {
      const data = await this.dbService
        .query()
        .from<CruxRaw>(CruxRepository.TABLE_NAME)
        .select(CruxRepository.BASE_SELECT)
        .where('author_id', authorId)
        .where('slug', slug)
        .whereNull('deleted')
        .first();

      return success(data);
    } catch (error) {
      return failure(error);
    }
  }

  async create(cruxData: CreateCruxDto): Promise<RepositoryResponse<CruxRaw>> {
    try {
      const tableFields = toTableFields({
        id: cruxData.id,
        slug: cruxData.slug,
        title: cruxData.title,
        description: cruxData.description,
        data: cruxData.data,
        type: cruxData.type,
        kind: cruxData.kind,
        status: cruxData.status,
        visibility: cruxData.visibility,
        discoverable: cruxData.discoverable,
        meta: cruxData.meta,
        authorId: cruxData.authorId,
        homeId: cruxData.homeId,
      });

      await this.dbService
        .query()
        .from<CruxRaw>(CruxRepository.TABLE_NAME)
        .insert({
          ...tableFields,
          created: new Date(),
          updated: new Date(),
        });

      const data = await this.dbService
        .query()
        .from<CruxRaw>(CruxRepository.TABLE_NAME)
        .select(CruxRepository.BASE_SELECT)
        .where('id', cruxData.id)
        .first();

      return success(data);
    } catch (error) {
      return failure(error);
    }
  }

  async update(
    cruxId: string,
    updateData: UpdateCruxDto & { remoteId?: string },
    protectedMetaKeys: string[] = [],
  ): Promise<RepositoryResponse<CruxRaw>> {
    try {
      const tableFields = toTableFields({
        remoteId: updateData.remoteId,
        slug: updateData.slug,
        title: updateData.title,
        description: updateData.description,
        data: updateData.data,
        type: updateData.type,
        kind: updateData.kind,
        status: updateData.status,
        visibility: updateData.visibility,
        discoverable: updateData.discoverable,
        meta: updateData.meta,
      });

      if (!protectedMetaKeys.length || tableFields.meta === undefined) {
        await this.dbService
          .query()
          .from<CruxRaw>('cruxes')
          .where('id', cruxId)
          .update({ ...tableFields, updated: new Date() });
        const data = await this.dbService
          .query()
          .from<CruxRaw>('cruxes')
          .select('*')
          .where('id', cruxId)
          .first();
        return success(data);
      }
      const data = await this.dbService.query().transaction(async (trx) => {
        // Preserve publication authority from the locked row, including when a stale client
        // syncs its metadata while another request finishes publishing.
        if (tableFields.meta !== undefined && protectedMetaKeys.length) {
          const current = await trx('cruxes')
            .where({ id: cruxId })
            .forUpdate()
            .first();
          const meta = { ...(tableFields.meta as Record<string, unknown>) };
          for (const key of protectedMetaKeys) {
            delete meta[key];
            if (current?.meta?.[key] !== undefined)
              meta[key] = current.meta[key];
          }
          tableFields.meta = meta;
        }
        const [row] = await trx('cruxes')
          .where({ id: cruxId })
          .update({ ...tableFields, updated: new Date() })
          .returning('*');
        return row;
      });

      return success(data);
    } catch (error) {
      return failure(error);
    }
  }

  /** Fence activation before external teardown starts; a failed teardown remains retryable. */
  async beginPublicationRemoval(
    cruxId: string,
  ): Promise<RepositoryResponse<CruxRaw>> {
    try {
      const data = await this.dbService.query().transaction(async (trx) => {
        const current = await trx('cruxes')
          .where({ id: cruxId })
          .whereNull('deleted')
          .forUpdate()
          .first();
        if (!current) throw new ConflictException('Crux no longer exists');
        const [row] = await trx('cruxes')
          .where({ id: cruxId })
          .update({
            meta: { ...current.meta, publicationRemoving: true },
            updated: new Date(),
          })
          .returning('*');
        return row;
      });
      return success(data);
    } catch (error) {
      return failure(error);
    }
  }

  /** Hold the same Crux row that publication activation locks while capturing its file inventory.
   * No storage/network work belongs inside this short transaction. */
  async publishedRevision(cruxId: string): Promise<
    RepositoryResponse<{
      crux: CruxRaw;
      artifacts: ArtifactRaw[];
    } | null>
  > {
    try {
      const data = await this.dbService.query().transaction(async (trx) => {
        const crux = await trx<CruxRaw>('cruxes')
          .where({ id: cruxId })
          .whereNull('deleted')
          .forShare()
          .first();
        if (!crux?.meta?.publishedAt || crux.meta.publicationRemoving)
          return null;
        const artifacts = await trx<ArtifactRaw>('artifacts')
          .where({
            resource_type: 'crux',
            resource_id: cruxId,
          })
          .whereNull('deleted')
          .whereRaw("meta->>'publishStorageId' = ?", [
            crux.meta.publishStorageId || cruxId,
          ])
          .orderBy('created', 'desc');
        return { crux, artifacts };
      });
      return success(data);
    } catch (error) {
      return failure(error);
    }
  }

  /** Storage is complete before this transaction. Publish identity, files and usage become visible together. */
  async commitPublication(
    cruxId: string,
    authorId: string,
    expectedVersion: number,
    artifacts: Artifact[],
    publicationMeta: Record<string, unknown>,
    schedules: { name: string; schedule: string; nextRun: Date }[],
  ): Promise<RepositoryResponse<CruxRaw>> {
    try {
      const data = await this.dbService.query().transaction(async (trx) => {
        const current = await trx('cruxes')
          .where({ id: cruxId, author_id: authorId })
          .whereNull('deleted')
          .forUpdate()
          .first();
        if (
          !current ||
          current.meta?.publicationRemoving ||
          (current.meta?.publishedVersion || 0) !== expectedVersion
        )
          throw new ConflictException(
            'The publication changed while uploading. Please retry.',
          );
        const retired = [...(current.meta?.retiredPublications || [])];
        if (current.meta?.publishedAt)
          retired.push({
            storageId: current.meta.publishStorageId || cruxId,
            layout: current.meta.publishLayout || 'shared',
          });
        await trx('artifacts')
          .where({ resource_type: 'crux', resource_id: cruxId })
          .whereNull('deleted')
          .update({ deleted: new Date(), updated: new Date() });
        if (artifacts.length)
          await trx.batchInsert(
            'artifacts',
            artifacts.map((a) => toTableFields(a)),
            100,
          );
        await replaceFunctionSchedules(trx, cruxId, schedules);
        await trx('usage_storage')
          .insert({
            crux_id: cruxId,
            author_id: authorId,
            bytes: publicationMeta.publishedBytes,
            files: artifacts.length,
            updated: new Date(),
          })
          .onConflict('crux_id')
          .merge();
        // The durable domain lifecycle retries origin activation after commit, including after restart.
        await trx('custom_domains')
          .where({ crux_id: cruxId })
          .whereNull('deleted')
          .whereNotNull('tenant_id')
          .whereIn('status', ['active', 'issuing'])
          .update({
            status: 'issuing',
            error: 'Publication update pending',
            updated: new Date(),
          });
        const [row] = await trx('cruxes')
          .where({ id: cruxId })
          .update({
            meta: {
              ...current.meta,
              ...publicationMeta,
              retiredPublications: retired,
            },
            visibility: 'public',
            updated: new Date(),
          })
          .returning('*');
        return row;
      });
      return success(data);
    } catch (error) {
      return failure(error);
    }
  }

  async delete(
    cruxId: string,
    trx?: Knex.Transaction,
    hard = false,
  ): Promise<RepositoryResponse<void>> {
    try {
      const query = trx || this.dbService.query();

      // First, get the crux to find its author
      const crux = await query
        .from<CruxRaw>(CruxRepository.TABLE_NAME)
        .where('id', cruxId)
        .first();

      if (!crux) {
        return failure(new Error('Crux not found'));
      }

      if (hard) {
        // Hard delete — remove crux and all related entities from database
        await query
          .from('tags')
          .where('resource_type', 'crux')
          .where('resource_id', cruxId)
          .del();

        await query
          .from('artifacts')
          .where('resource_type', 'crux')
          .where('resource_id', cruxId)
          .del();

        await query
          .from('dimensions')
          .where(function () {
            this.where('source_id', cruxId).orWhere('target_id', cruxId);
          })
          .andWhere('author_id', crux.author_id)
          .del();

        await query
          .from<CruxRaw>(CruxRepository.TABLE_NAME)
          .where('id', cruxId)
          .del();
      } else {
        const now = new Date();

        // Soft delete the crux
        await query
          .from<CruxRaw>(CruxRepository.TABLE_NAME)
          .where('id', cruxId)
          .update({
            deleted: now,
            updated: now,
          });

        // Also soft delete all dimensions where:
        // 1. This crux is involved (source OR target)
        // 2. AND the dimension was created by the same author as the crux
        // This preserves other people's dimensions that reference this crux
        await query
          .from('dimensions')
          .where(function () {
            this.where('source_id', cruxId).orWhere('target_id', cruxId);
          })
          .andWhere('author_id', crux.author_id)
          .update({
            deleted: now,
            updated: now,
          });
      }

      return success(undefined);
    } catch (error) {
      return failure(error);
    }
  }

  /* takedowns */

  // Takedowns are their own table rather than a column on `cruxes`: unpublish
  // hard-deletes the crux row, and the refusal must outlive it so the same id
  // cannot be synced and published again.

  findTakedownsQuery(
    activeOnly = false,
  ): Knex.QueryBuilder<TakedownRaw, TakedownRaw[]> {
    const query = this.dbService
      .query()
      .from<TakedownRaw>(CruxRepository.TAKEDOWNS_TABLE)
      .select<TakedownRaw[]>('*')
      .whereNull('deleted')
      .orderBy('created', 'desc') as Knex.QueryBuilder<
      TakedownRaw,
      TakedownRaw[]
    >;
    if (activeOnly) query.whereNull('lifted');
    return query;
  }

  async findActiveTakedown(
    cruxId: string,
  ): Promise<RepositoryResponse<TakedownRaw | undefined>> {
    try {
      const data = await this.dbService
        .query()
        .from<TakedownRaw>(CruxRepository.TAKEDOWNS_TABLE)
        .select('*')
        .where('crux_id', cruxId)
        .whereNull('lifted')
        .whereNull('deleted')
        .first();

      return success(data);
    } catch (error) {
      return failure(error);
    }
  }

  async createTakedown(takedown: {
    id: string;
    cruxId: string;
    authorId?: string;
    reason: string;
    reportId?: string;
    createdBy: string;
  }): Promise<RepositoryResponse<TakedownRaw>> {
    try {
      await this.dbService
        .query()
        .from<TakedownRaw>(CruxRepository.TAKEDOWNS_TABLE)
        .insert({
          ...toTableFields(takedown),
          created: new Date(),
          updated: new Date(),
        });

      const data = await this.dbService
        .query()
        .from<TakedownRaw>(CruxRepository.TAKEDOWNS_TABLE)
        .select('*')
        .where('id', takedown.id)
        .first();

      return success(data);
    } catch (error) {
      return failure(error);
    }
  }

  /** Returns the lifted record, or undefined when no takedown was active. */
  async liftTakedown(
    cruxId: string,
    liftedBy: string,
  ): Promise<RepositoryResponse<TakedownRaw | undefined>> {
    try {
      const active = await this.dbService
        .query()
        .from<TakedownRaw>(CruxRepository.TAKEDOWNS_TABLE)
        .select('id')
        .where('crux_id', cruxId)
        .whereNull('lifted')
        .whereNull('deleted')
        .first();
      if (!active) return success(undefined);

      const now = new Date();
      await this.dbService
        .query()
        .from<TakedownRaw>(CruxRepository.TAKEDOWNS_TABLE)
        .where('id', active.id)
        .update({ lifted: now, lifted_by: liftedBy, updated: now });

      const data = await this.dbService
        .query()
        .from<TakedownRaw>(CruxRepository.TAKEDOWNS_TABLE)
        .select('*')
        .where('id', active.id)
        .first();

      return success(data);
    } catch (error) {
      return failure(error);
    }
  }

  /* ~takedowns */

  async findAllByAuthorId(
    authorId: string,
  ): Promise<RepositoryResponse<CruxRaw[]>> {
    try {
      const data = await this.dbService
        .query()
        .from<CruxRaw>(CruxRepository.TABLE_NAME)
        .select(CruxRepository.BASE_SELECT)
        .where('author_id', authorId)
        .whereNull('deleted');

      return success(data);
    } catch (error) {
      return failure(error);
    }
  }
}
