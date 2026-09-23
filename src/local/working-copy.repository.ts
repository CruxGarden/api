import { Injectable } from '@nestjs/common';
import { DbService } from '../common/services/db.service';
import { success, failure } from '../common/helpers/repository-helpers';

interface WorkingCopyRow {
  id: string;
  crux_id: string;
  meta: Record<string, unknown>;
  revision: number;
  role: string;
  phase: string;
}

/** Transitional desktop Task records, owned by the same API database. */
@Injectable()
export class WorkingCopyRepository {
  constructor(private readonly db: DbService) {}

  async find(id: string) {
    try {
      return success<WorkingCopyRow>(
        await this.db.query()('working_copies').where({ id }).first(),
      );
    } catch (error) {
      return failure<WorkingCopyRow>(error);
    }
  }

  async hasApplyingMerge(id: string) {
    try {
      const row = await this.db
        .query()('task_merges')
        .where({ phase: 'applying' })
        .andWhere((query) =>
          query.where({ copy_id: id }).orWhere({ candidate_id: id }),
        )
        .first('id');
      return success({ pending: !!row });
    } catch (error) {
      return failure<{ pending: boolean }>(error);
    }
  }

  async setArchived(id: string, revision: number, phase: 'ready' | 'archived') {
    try {
      const changes = await this.db
        .query()('working_copies')
        .where({ id, revision })
        .update({
          phase,
          revision: revision + 1,
          updated: new Date(),
        });
      const saved = await this.db
        .query()('working_copies')
        .where({ id })
        .first('phase', 'revision');
      if (
        changes !== 1 ||
        saved?.phase !== phase ||
        saved?.revision !== revision + 1
      )
        throw new Error(
          'This task changed while saving. Reload it before retrying.',
        );
      return success({ changes });
    } catch (error) {
      return failure<{ changes: number }>(error);
    }
  }

  async updateMeta(
    id: string,
    revision: number,
    meta: Record<string, unknown>,
    title?: string,
  ) {
    try {
      const changes = await this.db
        .query()('working_copies')
        .where({ id, revision })
        .update({
          meta,
          ...(title === undefined ? {} : { title }),
          revision: revision + 1,
          updated: new Date(),
        });
      return success({ changes });
    } catch (error) {
      return failure<{ changes: number }>(error);
    }
  }
}
