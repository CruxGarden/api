import { Injectable } from '@nestjs/common';
import { DbService } from '../common/services/db.service';
import { success, failure } from '../common/helpers/repository-helpers';
import { randomUUID } from 'crypto';
import { LocalWorkingCopyCreate } from './working-copy-create';

interface WorkingCopyRow {
  id: string;
  crux_id: string;
  task_id: string;
  base_snapshot_id: string;
  meta: Record<string, unknown>;
  revision: number;
  role: string;
  phase: string;
  project_folder: string | null;
}

/** Transitional desktop Task records, owned by the same API database. */
@Injectable()
export class WorkingCopyRepository {
  constructor(private readonly db: DbService) {}

  async creationContext(input: LocalWorkingCopyCreate) {
    try {
      const db = this.db.query();
      const collision =
        !!(await db('working_copies').where({ id: input.id }).first('id')) ||
        !!(await db('cruxes').where({ id: input.id }).first('id'));
      const base = await db('cruxes')
        .where({ id: input.baseSnapshotId, kind: 'snapshot' })
        .whereNull('deleted')
        .first();
      const linked = !!(await db('dimensions')
        .where({
          source_id: input.cruxId,
          target_id: input.baseSnapshotId,
          type: 'growth',
        })
        .whereNull('deleted')
        .first('id'));
      const pending = !!(await db('task_merges')
        .where({ crux_id: input.cruxId, phase: 'applying' })
        .first('id'));
      return success({ collision, base, linked, pending });
    } catch (error) {
      return failure<{
        collision: boolean;
        base: any;
        linked: boolean;
        pending: boolean;
      }>(error);
    }
  }

  async create(input: LocalWorkingCopyCreate) {
    try {
      const db = this.db.query();
      const now = new Date();
      const record = {
        id: input.id,
        crux_id: input.cruxId,
        task_id: input.taskId,
        title: input.title,
        base_snapshot_id: input.baseSnapshotId,
        role: input.role,
        phase: 'preparing',
        meta: input.meta,
        project_folder: null,
        revision: 0,
        created: now,
        updated: now,
      };
      await db('working_copies').insert(record);
      // Preview data is a private independent copy, including every visitor slot
      // and unknown extension column. It never aliases the live Crux's Store.
      const original = await db('store')
        .where({ crux_id: input.cruxId })
        .orderBy('id');
      const clones = original.map((row) => ({
        ...row,
        id: randomUUID(),
        crux_id: input.id,
      }));
      for (const row of clones) await db('store').insert(row);
      const saved = await db('working_copies').where({ id: input.id }).first();
      for (const [field, expected] of Object.entries(record))
        if (JSON.stringify(saved?.[field]) !== JSON.stringify(expected))
          throw new Error('Task preparation did not persist');
      const copied = await db('store')
        .where({ crux_id: input.id })
        .orderBy('id');
      const sorted = clones.sort((a, b) => a.id.localeCompare(b.id));
      if (
        JSON.stringify(copied) !== JSON.stringify(sorted) ||
        JSON.stringify(
          await db('store').where({ crux_id: input.cruxId }).orderBy('id'),
        ) !== JSON.stringify(original)
      )
        throw new Error('Task preview data did not copy completely');
      return success({ created: true });
    } catch (error) {
      return failure<{ created: boolean }>(error);
    }
  }

  async find(id: string) {
    try {
      return success<WorkingCopyRow>(
        await this.db.query()('working_copies').where({ id }).first(),
      );
    } catch (error) {
      return failure<WorkingCopyRow>(error);
    }
  }

  async setSetup(
    copy: WorkingCopyRow,
    phase: 'preparing' | 'ready' | 'failed',
    folder: string | null,
  ) {
    try {
      const db = this.db.query();
      const changed = await db('working_copies')
        .where({ id: copy.id, phase: copy.phase, revision: copy.revision })
        .update({
          phase,
          project_folder: folder,
          revision: copy.revision + 1,
          updated: new Date(),
        });
      const saved = await db('working_copies').where({ id: copy.id }).first();
      if (
        changed !== 1 ||
        saved?.phase !== phase ||
        saved?.revision !== copy.revision + 1 ||
        saved?.project_folder !== folder ||
        saved?.task_id !== copy.task_id ||
        saved?.base_snapshot_id !== copy.base_snapshot_id ||
        saved?.crux_id !== copy.crux_id ||
        saved?.role !== copy.role ||
        JSON.stringify(saved?.meta) !== JSON.stringify(copy.meta)
      )
        throw new Error(
          'Task setup changed while saving. Reopen the Task before retrying.',
        );
      return success({ saved: true });
    } catch (error) {
      return failure<{ saved: boolean }>(error);
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
