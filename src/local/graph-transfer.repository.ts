import type { SelectedGraphCapture } from './selected-graph.service';
import { Injectable } from '@nestjs/common';
import { isDeepStrictEqual } from 'util';
import { DbService } from '../common/services/db.service';
import { toTableFields, toEntityFields } from '../common/helpers/case-helpers';
import { success, failure } from '../common/helpers/repository-helpers';
import type { GraphBoundary, PrivateGraphImportResult } from './portable-graph';

type Table =
  | 'cruxes'
  | 'dimensions'
  | 'working_copies'
  | 'task_merges'
  | 'store'
  | 'file_content_heads'
  | 'edit_history';
const receiptKey = (id: string) => `cruxgarden:graph-import:${id}`;
const boundaryKey = (id: string) => `cruxgarden:graph-boundary:${id}`;

@Injectable()
export class GraphTransferRepository {
  constructor(private readonly db: DbService) {}
  async receipt(id: string) {
    try {
      const row = await this.db
        .query()('settings')
        .where({ key: receiptKey(id) })
        .first();
      return success(
        row
          ? (JSON.parse(row.value) as {
              digest: string;
              result: PrivateGraphImportResult;
            })
          : null,
      );
    } catch (error) {
      return failure<never>(error);
    }
  }
  async remember(id: string, digest: string, result: PrivateGraphImportResult) {
    try {
      const value = JSON.stringify({ digest, result });
      const key = receiptKey(id);
      await this.db.query()('settings').insert({ key, value });
      if (
        (await this.db.query()('settings').where({ key }).first())?.value !==
        value
      )
        throw new Error('Graph import receipt did not persist');
      return success(true);
    } catch (error) {
      return failure<boolean>(error);
    }
  }
  async boundaries(sources: string[]) {
    try {
      const result: GraphBoundary = [];
      for (const source of sources) {
        const row = await this.db
          .query()('settings')
          .where({ key: boundaryKey(source) })
          .first();
        if (row) result.push(...JSON.parse(row.value));
      }
      return success(result);
    } catch (error) {
      return failure<GraphBoundary>(error);
    }
  }
  async keepBoundaries(boundary: GraphBoundary) {
    try {
      for (const source of new Set(boundary.map((edge) => edge.sourceId))) {
        const key = boundaryKey(source);
        const value = JSON.stringify(
          boundary.filter((edge) => edge.sourceId === source),
        );
        await this.db.query()('settings').insert({ key, value });
        if (
          (await this.db.query()('settings').where({ key }).first())?.value !==
          value
        )
          throw new Error('Unresolved graph references did not persist');
      }
      return success(true);
    } catch (error) {
      return failure<boolean>(error);
    }
  }
  async available(ids: string[]) {
    try {
      for (const table of [
        'cruxes',
        'working_copies',
        'dimensions',
        'task_merges',
        'store',
      ] as const)
        for (let i = 0; i < ids.length; i += 200)
          if (
            await this.db
              .query()(table)
              .whereIn('id', ids.slice(i, i + 200))
              .first('id')
          )
            throw new Error(
              'An imported identity already exists; choose Copy or resolve the conflict',
            );
      return success(true);
    } catch (error) {
      return failure<boolean>(error);
    }
  }
  async replacementBoundary(
    capture: SelectedGraphCapture,
    retained: Set<string>,
  ) {
    try {
      const owners = [...capture.cruxes, ...capture.workingCopies].map(
        (row) => row.id,
      );
      const selected = new Set(owners);
      const roots = new Set(capture.selection.roots);
      const external: Record<string, any>[] = [];
      const db = this.db.query();
      for (let start = 0; start < owners.length; start += 200) {
        const batch = owners.slice(start, start + 200);
        const incoming = await db('dimensions')
          .whereIn('target_id', batch)
          .whereNull('deleted');
        if (
          incoming.some(
            (row) => !selected.has(row.source_id) && !roots.has(row.target_id),
          )
        )
          throw new Error(
            'This selection shares members or history with other work. Import a copy instead.',
          );
        const outgoing = await db('dimensions')
          .whereIn('source_id', batch)
          .whereNull('deleted');
        for (const row of outgoing)
          if (!selected.has(row.target_id) && retained.has(row.source_id))
            external.push(JSON.parse(JSON.stringify(toEntityFields(row))));
      }
      return success(external);
    } catch (error) {
      return failure<Record<string, any>[]>(error);
    }
  }

  /** Scoped archive restoration, not lifecycle deletion. The caller retains a
   * verified safety archive first and owns the encompassing rollback transaction. */
  async replaceSelection(capture: SelectedGraphCapture) {
    try {
      const db = this.db.query();
      const owners = [...capture.cruxes, ...capture.workingCopies].map(
        (row) => row.id,
      );
      for (let start = 0; start < owners.length; start += 200) {
        const batch = owners.slice(start, start + 200);
        for (const [table, column] of [
          ['file_content_heads', 'crux_id'],
          ['edit_history', 'crux_id'],
          ['store', 'crux_id'],
          ['task_merges', 'crux_id'],
          ['dimensions', 'source_id'],
          ['working_copies', 'id'],
          ['cruxes', 'id'],
        ]) {
          await db(table).whereIn(column, batch).delete();
          if (await db(table).whereIn(column, batch).first())
            throw new Error(
              'The selected archive replacement did not clear its records',
            );
        }
        await db('settings').whereIn('key', batch.map(boundaryKey)).delete();
      }
      return success(true);
    } catch (error) {
      return failure<boolean>(error);
    }
  }

  async bindFolder(workspace: Record<string, any>, copy: boolean) {
    try {
      const db = this.db.query();
      const folder = copy
        ? workspace.projectFolder
        : workspace.meta.projectFolder;
      if (
        (await db('cruxes')
          .whereRaw("json_extract(meta, '$.projectFolder') = ?", [folder])
          .first('id')) ||
        (await db('working_copies')
          .where({ project_folder: folder })
          .first('id'))
      )
        throw new Error('Imported Project folder is already registered');
      const table = copy ? 'working_copies' : 'cruxes';
      const patch = copy
        ? { project_folder: folder, phase: workspace.phase }
        : { meta: workspace.meta };
      if ((await db(table).where({ id: workspace.id }).update(patch)) !== 1)
        throw new Error('Imported Project folder binding did not persist');
      return success(true);
    } catch (error) {
      return failure<boolean>(error);
    }
  }

  /** The owning service validates graph meaning; the repository verifies exact
   * writes too, so ignored/altered inserts cannot produce a partial success. */
  async insert(table: Table, rows: Record<string, any>[]) {
    try {
      for (const row of rows) {
        await this.db.query()(table).insert(toTableFields(row));
        const key =
          table === 'file_content_heads' || table === 'edit_history'
            ? { crux_id: row.cruxId }
            : { id: row.id };
        const saved = await this.db.query()(table).where(key).first();
        if (!saved) throw new Error('Imported graph record did not persist');
        const actual = JSON.parse(JSON.stringify(toEntityFields(saved)));
        for (const [field, value] of Object.entries(row))
          if (!isDeepStrictEqual(actual[field], value))
            throw new Error(
              `Imported graph record changed during admission: ${field}`,
            );
      }
      return success(true);
    } catch (error) {
      return failure<boolean>(error);
    }
  }
}
