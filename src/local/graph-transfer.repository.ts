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
  | 'file_content_heads';
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
  /** The owning service validates graph meaning; the repository verifies exact
   * writes too, so ignored/altered inserts cannot produce a partial success. */
  async insert(table: Table, rows: Record<string, any>[]) {
    try {
      for (const row of rows) {
        await this.db.query()(table).insert(toTableFields(row));
        const key =
          table === 'file_content_heads'
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
