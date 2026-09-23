import { Injectable } from '@nestjs/common';
import { DbService } from '../common/services/db.service';
import { RepositoryResponse } from '../common/types/interfaces';
import { success, failure } from '../common/helpers/repository-helpers';

/** Candidate schema; installed only by isolated fixtures until versioned migration lands. */
export const FILE_CONTENT_SCHEMA = `CREATE TABLE file_content_heads (
  crux_id TEXT PRIMARY KEY NOT NULL,
  format_version INTEGER NOT NULL,
  root TEXT NOT NULL,
  revision INTEGER NOT NULL
)`;
export interface FileContentHead {
  cruxId: string;
  formatVersion: 1;
  root: string;
  revision: number;
}

interface FileContentContext {
  crux: { id: string; deleted: string | null; kind: string | null } | undefined;
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
      const crux = await db('cruxes')
        .where({ id })
        .first('id', 'deleted', 'kind');
      const row = await db('file_content_heads').where({ crux_id: id }).first();
      const legacy = !!(await db('artifacts')
        .where({ resource_id: id })
        .first('id'));
      const task = !!(await db('working_copies')
        .where({ crux_id: id })
        .first('id'));
      const review = !!(await db('task_merges')
        .where({ crux_id: id })
        .first('id'));
      const history = !!(await db('dimensions')
        .where({ type: 'growth' })
        .whereNull('deleted')
        .andWhere((query) =>
          query.where({ source_id: id }).orWhere({ target_id: id }),
        )
        .first('id'));
      const head: FileContentHead | null = row
        ? {
            cruxId: row.crux_id,
            formatVersion: row.format_version,
            root: row.root,
            revision: row.revision,
          }
        : null;
      return success({ crux, head, legacy, task, review, history });
    } catch (error) {
      return failure<FileContentContext>(error);
    }
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
