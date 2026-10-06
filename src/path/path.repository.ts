import { Injectable } from '@nestjs/common';
import { toTableFields } from '../common/helpers/case-helpers';
import { DbService } from '../common/services/db.service';
import { RepositoryResponse } from '../common/types/interfaces';
import { success, failure } from '../common/helpers/repository-helpers';
import PathRaw from './entities/path-raw.entity';
import MarkerRaw from './entities/marker-raw.entity';
import { CreatePathDto } from './dto/create-path.dto';
import { UpdatePathDto } from './dto/update-path.dto';
import { MarkerInput } from './dto/sync-markers.dto';

type NewPath = CreatePathDto & { id: string; authorId: string; homeId: string };
type NewMarker = MarkerInput & { id: string };

@Injectable()
export class PathRepository {
  constructor(private readonly db: DbService) {}

  findAllQuery(authorId: string) {
    return this.db
      .query()
      .from<PathRaw>('paths')
      .select('*')
      .where('author_id', authorId)
      .whereNull('deleted')
      .orderBy('created', 'desc')
      .orderBy('id');
  }

  async findBy(
    field: 'id' | 'slug',
    value: string,
    authorId?: string,
  ): Promise<RepositoryResponse<PathRaw>> {
    try {
      const query = this.db
        .query()
        .from<PathRaw>('paths')
        .where(field, value)
        .whereNull('deleted');
      if (authorId !== undefined) query.where('author_id', authorId);
      return success(await query.first());
    } catch (error) {
      return failure(error);
    }
  }

  async create(data: NewPath): Promise<RepositoryResponse<PathRaw>> {
    try {
      const [row] = await this.db
        .query()
        .from<PathRaw>('paths')
        .insert({
          ...toTableFields({
            id: data.id,
            slug: data.slug,
            title: data.title,
            description: data.description,
            type: data.type,
            kind: data.kind,
            visibility: data.visibility,
            authorId: data.authorId,
            homeId: data.homeId,
          }),
          entry: null,
          created: new Date(),
          updated: new Date(),
        })
        .returning('*');
      return success(row);
    } catch (error) {
      return failure(error);
    }
  }

  async update(
    id: string,
    authorId: string,
    data: UpdatePathDto,
  ): Promise<RepositoryResponse<PathRaw>> {
    try {
      const [row] = await this.db
        .query()
        .from<PathRaw>('paths')
        .where({ id, author_id: authorId })
        .whereNull('deleted')
        .update({
          ...toTableFields({
            title: data.title,
            description: data.description,
            type: data.type,
            kind: data.kind,
            visibility: data.visibility,
            entry: data.entry,
          }),
          updated: new Date(),
        })
        .returning('*');
      return success(row);
    } catch (error) {
      return failure(error);
    }
  }

  async delete(
    id: string,
    authorId: string,
  ): Promise<RepositoryResponse<void>> {
    try {
      await this.db
        .query()
        .from('paths')
        .where({ id, author_id: authorId })
        .whereNull('deleted')
        .update({ deleted: new Date(), updated: new Date() });
      return success(undefined);
    } catch (error) {
      return failure(error);
    }
  }

  async findMarkersByPathId(
    pathId: string,
    authorId: string,
  ): Promise<RepositoryResponse<MarkerRaw[]>> {
    try {
      const rows = await this.db
        .query()
        .from<MarkerRaw>('markers as m')
        .select('m.*')
        .join('cruxes as c', 'c.id', 'm.crux_id')
        .where({
          'm.path_id': pathId,
          'm.author_id': authorId,
          'c.author_id': authorId,
        })
        .whereNull('m.deleted')
        .whereNull('c.deleted')
        .orderBy('m.order');
      return success(rows);
    } catch (error) {
      return failure(error);
    }
  }

  /** Replace the live sequence and entry together, retaining all removed marker records. */
  async replaceMarkers(
    pathId: string,
    authorId: string,
    markers: NewMarker[],
  ): Promise<RepositoryResponse<MarkerRaw[]>> {
    try {
      const rows = await this.db.transaction(async () => {
        const query = this.db.query();
        const path = await query<PathRaw>('paths')
          .where({ id: pathId, author_id: authorId })
          .whereNull('deleted')
          .forUpdate()
          .first();
        if (!path) throw new Error('Path changed before marker replacement');
        const previousEntry = path.entry
          ? await query<MarkerRaw>('markers')
              .where({ id: path.entry, path_id: pathId })
              .whereNull('deleted')
              .first()
          : null;
        const now = new Date();
        await query('markers')
          .where('path_id', pathId)
          .whereNull('deleted')
          .update({ deleted: now, updated: now });
        const result = markers.length
          ? await query<MarkerRaw>('markers')
              .insert(
                markers.map((marker) => ({
                  id: marker.id,
                  path_id: pathId,
                  crux_id: marker.cruxId,
                  order: marker.order,
                  note: marker.note ?? null,
                  author_id: authorId,
                  created: now,
                  updated: now,
                })),
              )
              .returning('*')
          : [];
        result.sort((a, b) => a.order - b.order);
        // Keep the selected Crux as the entry when it remains in the sequence.
        const entry =
          result.find((marker) => marker.crux_id === previousEntry?.crux_id)
            ?.id ??
          result[0]?.id ??
          null;
        await query('paths')
          .where({ id: pathId, author_id: authorId })
          .update({ entry, updated: now });
        return result;
      });
      return success(rows);
    } catch (error) {
      return failure(error);
    }
  }
}
