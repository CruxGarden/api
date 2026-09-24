import { readCopySources, copyParentOwner } from './working-copy-base';
import { isDeepStrictEqual } from 'util';
import { Injectable } from '@nestjs/common';
import { toEntityFields } from '../common/helpers/case-helpers';
import Crux from '../crux/entities/crux.entity';
import { DbService } from '../common/services/db.service';
import { RepositoryResponse } from '../common/types/interfaces';
import { success, failure } from '../common/helpers/repository-helpers';

export interface FileContentHead {
  cruxId: string;
  formatVersion: 1;
  root: string;
  revision: number;
}

interface FileContentContext {
  crux: Crux | undefined;
  closed: boolean;
  projection: boolean;
  head: FileContentHead | null;
  legacy: boolean;
  task: boolean;
  review: boolean;
  history: boolean;
}

@Injectable()
export class FileContentRepository {
  constructor(private readonly db: DbService) {}

  async context(id: string): Promise<RepositoryResponse<FileContentContext>> {
    try {
      const db = this.db.query();
      if (!(await db.schema.hasTable('file_content_heads')))
        throw new Error('File content schema has not been adopted');
      const record = await db('cruxes').where({ id }).first();
      const copy = await db('working_copies').where({ id }).first();
      if (record && copy) throw new Error('Ambiguous content owner identity');
      const parent = copy
        ? await db('cruxes').where({ id: copy.crux_id }).first()
        : null;
      const crux = record
        ? (toEntityFields(record) as unknown as Crux)
        : parent
          ? ({
              ...toEntityFields(parent),
              id: copy.id,
              kind: null,
              title: copy.title,
              meta: copy.meta,
              type: 'working-copy',
              created: copy.created,
              updated: copy.updated,
            } as unknown as Crux)
          : undefined;
      const closed =
        !!copy &&
        (!['preparing', 'ready'].includes(copy.phase) ||
          !['task', 'review'].includes(copy.role));
      const row = await db('file_content_heads').where({ crux_id: id }).first();
      const legacy = !!(await db('artifacts')
        .where({ resource_id: id })
        .first('id'));
      const task = !!(await db('working_copies as w')
        .leftJoin('file_content_heads as h', 'h.crux_id', 'w.id')
        .where({ 'w.crux_id': id })
        .whereNull('h.crux_id')
        .first('w.id'));
      const review = !!(await db('task_merges')
        .where({ crux_id: copy?.crux_id ?? id, phase: 'applying' })
        .first('id'));
      // Only retained snapshot relationships admit further edits. Do not mix an
      // unrepresented historical file authority into the new writer.
      const history = !!(await db('dimensions as d')
        .leftJoin('cruxes as c', 'c.id', 'd.target_id')
        .leftJoin('file_content_heads as h', 'h.crux_id', 'c.id')
        .where({ 'd.type': 'growth' })
        .whereNull('d.deleted')
        .andWhere((query) =>
          query
            .where({ 'd.target_id': id })
            .orWhere((outgoing) =>
              outgoing
                .where({ 'd.source_id': id })
                .andWhere((invalid) =>
                  invalid
                    .whereNull('c.id')
                    .orWhereNot('c.kind', 'snapshot')
                    .orWhereNull('c.kind')
                    .orWhereNotNull('c.deleted')
                    .orWhereNull('h.crux_id')
                    .orWhereNot('h.format_version', 1)
                    .orWhereNot('h.revision', 1)
                    .orWhereRaw(
                      "length(h.root) <> 64 OR h.root GLOB '*[^a-f0-9]*'",
                    )
                    .orWhereRaw(
                      "CASE WHEN json_valid(c.meta) THEN json_extract(c.meta, '$.contentOwnerId') ELSE NULL END IS NOT ?",
                      [id],
                    )
                    .orWhereExists(
                      db('artifacts as a')
                        .select('a.id')
                        .whereRaw('a.resource_id = c.id'),
                    ),
                ),
            ),
        )
        .first('d.id'));
      const head: FileContentHead | null = row
        ? {
            cruxId: row.crux_id,
            formatVersion: row.format_version,
            root: row.root,
            revision: row.revision,
          }
        : null;
      const projection = !!(await db('settings')
        .where({ key: this.projectionKey(id) })
        .first());
      return success({
        crux,
        closed,
        projection,
        head,
        legacy,
        task,
        review,
        history,
      });
    } catch (error) {
      return failure<FileContentContext>(error);
    }
  }

  private projectionKey(id: string) {
    return `cruxgarden:content-projection:${id}`;
  }

  /** A Task's first-parent ancestry may enter its declared Main base only. */
  async parentOwner(id: string, parentId: string): Promise<string> {
    const copies = await readCopySources(id, (sourceId) =>
      this.db.query()('working_copies').where({ id: sourceId }).first(),
    );
    return copyParentOwner(id, parentId, copies);
  }

  async applyingMerge(id: string, mergeId: string): Promise<boolean> {
    return !!(await this.db
      .query()('task_merges')
      .where({ id: mergeId, phase: 'applying' })
      .whereRaw("COALESCE(json_extract(data, '$.targetId'), crux_id) = ?", [id])
      .first('id'));
  }

  async queueProjection(id: string, head: FileContentHead) {
    const db = this.db.query();
    const copy = await db('working_copies').where({ id }).first();
    const source = copy ?? (await db('cruxes').where({ id }).first());
    if (!source) throw new Error('Content owner not found');
    const folder = copy?.project_folder ?? source.meta?.projectFolder;
    if (!folder) return;
    if (typeof folder !== 'string') throw new Error('Invalid Project Folder');
    const pending = { head, folder };
    await db('settings').insert({
      key: this.projectionKey(id),
      value: JSON.stringify(pending),
    });
    if (!isDeepStrictEqual(await this.projection(id), pending))
      throw new Error('Content projection intent did not persist');
  }

  async projection(
    id: string,
  ): Promise<{ head: FileContentHead; folder: string } | null> {
    const row = await this.db
      .query()('settings')
      .where({ key: this.projectionKey(id) })
      .first();
    return row
      ? typeof row.value === 'string'
        ? JSON.parse(row.value)
        : row.value
      : null;
  }

  async assertProjectionOwner(
    id: string,
    pending: { head: FileContentHead; folder: string },
  ) {
    const db = this.db.query();
    const copy = await db('working_copies').where({ id }).first();
    const source = copy ?? (await db('cruxes').where({ id }).first());
    const folder = copy?.project_folder ?? source?.meta?.projectFolder;
    if (
      !source ||
      pending.head.cruxId !== id ||
      typeof pending.folder !== 'string' ||
      !pending.folder ||
      pending.folder !== folder
    )
      throw new Error(
        'Project Folder changed before projection; restore its ownership before retrying',
      );
  }

  async clearProjection(id: string) {
    const db = this.db.query();
    await db('settings')
      .where({ key: this.projectionKey(id) })
      .delete();
    if (await this.projection(id))
      throw new Error('Content projection completion did not persist');
  }

  async restoreWorkspace(
    id: string,
    expectedMeta: Record<string, unknown>,
    messages: unknown[],
    targetId: string | null,
    entryFile: unknown,
    head: FileContentHead,
  ) {
    const db = this.db.query();
    const copy = await db('working_copies').where({ id }).first();
    const table = copy ? 'working_copies' : 'cruxes';
    const source = copy ?? (await db('cruxes').where({ id }).first());
    if (!source || !isDeepStrictEqual(source.meta ?? {}, expectedMeta))
      throw new Error('Workspace changed before restore; reload and try again');
    const meta = {
      ...source.meta,
      messages,
      settings: {
        ...source.meta?.settings,
        activeBranch: targetId,
        entryFile: entryFile ?? null,
      },
    };
    await db(table)
      .where({ id })
      .update({
        meta,
        updated: new Date(),
        ...(copy ? { revision: copy.revision + 1 } : {}),
      });
    const saved = await db(table).where({ id }).first();
    if (!isDeepStrictEqual(saved?.meta, meta))
      throw new Error('Restored workspace state did not persist');
    await this.queueProjection(id, head);
  }

  async publish(head: FileContentHead, expected: FileContentHead | null) {
    try {
      const db = this.db.query();
      const record = {
        crux_id: head.cruxId,
        format_version: head.formatVersion,
        root: head.root,
        revision: head.revision,
      };
      if (expected) {
        const changed = await db('file_content_heads')
          .where({
            crux_id: expected.cruxId,
            root: expected.root,
            revision: expected.revision,
            format_version: 1,
          })
          .update(record);
        if (changed !== 1)
          throw new Error('File content publication was refused');
      } else await db('file_content_heads').insert(record);
      // Recent-work ordering and overwrite warnings belong to the owner, not
      // one database row per file. Retained snapshots keep their capture time.
      const crux = await db('cruxes').where({ id: head.cruxId }).first('kind');
      if (!crux || crux.kind !== 'snapshot') {
        const table = crux ? 'cruxes' : 'working_copies';
        const updated = new Date();
        const count = await db(table)
          .where({ id: head.cruxId })
          .update({ updated });
        const owner = await db(table)
          .where({ id: head.cruxId })
          .first('updated');
        if (
          count !== 1 ||
          new Date(owner?.updated).getTime() !== updated.getTime()
        )
          throw new Error('Content owner update did not persist');
      }
      const saved = await db('file_content_heads')
        .where({ crux_id: head.cruxId })
        .first();
      if (
        !saved ||
        saved.root !== head.root ||
        saved.revision !== head.revision ||
        saved.format_version !== 1
      )
        throw new Error('File content publication did not persist');
      return success(head);
    } catch (error) {
      return failure<FileContentHead>(error);
    }
  }
}
