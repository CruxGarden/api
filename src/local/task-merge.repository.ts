import { Injectable } from '@nestjs/common';
import { DbService } from '../common/services/db.service';
import { success, failure } from '../common/helpers/repository-helpers';

interface CopyRow {
  id: string;
  crux_id: string;
  role: string;
  phase: string;
  revision: number;
  title: string;
  base_state: string;
  meta: Record<string, any>;
}
export interface MergeRow {
  id: string;
  crux_id: string;
  copy_id: string;
  candidate_id: string;
  phase: string;
  data: string;
}
export interface MergeState {
  present?: boolean;
  merge?: MergeRow;
  copy?: CopyRow;
  candidate?: CopyRow;
  linked: boolean;
}
@Injectable()
export class TaskMergeRepository {
  constructor(private readonly db: DbService) {}
  async reviewAvailable(cruxId: string, candidateId: string, id: string) {
    try {
      const db = this.db.query();
      const pending = await db('task_merges')
        .where({ crux_id: cruxId, phase: 'applying' })
        .first('id');
      const used = await db('task_merges')
        .where({ candidate_id: candidateId })
        .whereNot({ id })
        .first('id');
      return success({ available: !pending && !used });
    } catch (error) {
      return failure<{ available: boolean }>(error);
    }
  }
  async saveReview(state: MergeState, data: Record<string, unknown>) {
    try {
      const db = this.db.query();
      const merge = state.merge!;
      const serialized = JSON.stringify(data);
      if (state.present) {
        const changed = await db('task_merges')
          .where({ id: merge.id, phase: 'review', data: merge.data })
          .update({ data: serialized });
        if (changed !== 1) throw new Error('The review changed while saving');
      } else {
        await db('task_merges').insert({
          ...merge,
          data: serialized,
          created: new Date(),
        });
      }
      const saved = await db('task_merges').where({ id: merge.id }).first();
      if (
        saved?.phase !== 'review' ||
        saved?.data !== serialized ||
        saved?.crux_id !== merge.crux_id ||
        saved?.copy_id !== merge.copy_id ||
        saved?.candidate_id !== merge.candidate_id
      )
        throw new Error('The review did not persist');
      for (const copy of [state.copy!, state.candidate!]) {
        const current = await db('working_copies')
          .where({ id: copy.id })
          .first();
        if (
          current?.phase !== 'ready' ||
          current?.revision !== copy.revision ||
          current?.crux_id !== merge.crux_id ||
          current?.role !== copy.role
        )
          throw new Error('The Task changed while saving the review');
      }
      return success({ saved: true });
    } catch (error) {
      return failure<{ saved: boolean }>(error);
    }
  }
  async admissionContext(cruxId: string, copyId: string) {
    try {
      const db = this.db.query();
      const pending = await db('task_merges')
        .where({ crux_id: cruxId, phase: 'applying' })
        .first('id');
      const growths = await db('dimensions as d')
        .join('cruxes as c', 'c.id', 'd.target_id')
        .whereIn('d.source_id', [cruxId, copyId])
        .where({ 'd.type': 'growth', 'c.kind': 'snapshot' })
        .whereNull('d.deleted')
        .whereNull('c.deleted')
        .select('d.source_id', 'd.target_id', 'd.weight', 'c.meta');
      return success({ pending: !!pending, growths });
    } catch (error) {
      return failure<{ pending: boolean; growths: any[] }>(error);
    }
  }
  async begin(state: MergeState, data: Record<string, unknown>) {
    try {
      const db = this.db.query();
      const merge = state.merge!;
      const serialized = JSON.stringify(data);
      const changed = await db('task_merges')
        .where({ id: merge.id, phase: 'review', data: merge.data })
        .update({ phase: 'applying', data: serialized });
      const saved = await db('task_merges').where({ id: merge.id }).first();
      if (
        changed !== 1 ||
        saved?.phase !== 'applying' ||
        saved?.data !== serialized
      )
        throw new Error('The merge journal did not admit this review');
      // Extension triggers must not close or redirect either copy as admission commits.
      for (const copy of [state.copy!, state.candidate!]) {
        const current = await db('working_copies')
          .where({ id: copy.id })
          .first();
        if (
          current?.phase !== 'ready' ||
          current?.revision !== copy.revision ||
          current?.crux_id !== merge.crux_id ||
          current?.role !== copy.role
        )
          throw new Error('The Task changed during merge admission');
      }
      return success({ admitted: true });
    } catch (error) {
      return failure<{ admitted: boolean }>(error);
    }
  }
  async inspect(id: string, draft?: MergeRow) {
    try {
      const db = this.db.query();
      const stored = await db('task_merges').where({ id }).first();
      const merge = stored ?? draft;
      if (!merge) return success<MergeState>({ linked: false });
      const copy = await db('working_copies')
        .where({ id: merge.copy_id })
        .first();
      const candidate = await db('working_copies')
        .where({ id: merge.candidate_id })
        .first();
      return success<MergeState>({
        present: !!stored,
        merge,
        copy,
        candidate,
        linked: false,
      });
    } catch (error) {
      return failure<MergeState>(error);
    }
  }
  async transition(
    state: MergeState,
    data: Record<string, unknown>,
    complete: boolean,
  ) {
    try {
      const db = this.db.query();
      const merge = state.merge!;
      const targets: [CopyRow, 'merged' | 'archived'][] = complete
        ? [
            [state.copy!, 'merged'],
            [state.candidate!, 'archived'],
          ]
        : [[state.candidate!, 'archived']];
      for (const [copy, phase] of targets) {
        if (copy.phase === phase) continue; // Recover an older partial finalization without incrementing twice.
        const changed = await db('working_copies')
          .where({ id: copy.id, revision: copy.revision, phase: copy.phase })
          .update({ phase, revision: copy.revision + 1, updated: new Date() });
        if (changed !== 1)
          throw new Error('Task changed during merge finalization');
      }
      const serialized = JSON.stringify(data);
      if (merge.phase !== data.phase || merge.data !== serialized) {
        const changed = await db('task_merges')
          .where({ id: merge.id, phase: merge.phase })
          .update({ phase: data.phase, data: serialized });
        if (changed !== 1) throw new Error('Merge journal did not commit');
      }
      // Check after all writes: a journal trigger can undo an earlier copy update.
      for (const [copy, phase] of targets) {
        const saved = await db('working_copies').where({ id: copy.id }).first();
        const revision = copy.revision + (copy.phase === phase ? 0 : 1);
        if (
          saved?.phase !== phase ||
          saved?.revision !== revision ||
          saved?.crux_id !== merge.crux_id
        )
          throw new Error('Task finalization did not persist');
      }
      const saved = await db('task_merges').where({ id: merge.id }).first();
      if (saved?.phase !== data.phase || saved?.data !== serialized)
        throw new Error('Merge journal did not persist');
      return success({ completed: true });
    } catch (error) {
      return failure<{ completed: boolean }>(error);
    }
  }
}
