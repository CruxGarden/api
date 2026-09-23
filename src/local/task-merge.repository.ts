import { Injectable } from '@nestjs/common';
import { DbService } from '../common/services/db.service';
import { success, failure } from '../common/helpers/repository-helpers';

interface CopyRow {
  id: string;
  crux_id: string;
  role: string;
  phase: string;
  revision: number;
}
interface MergeRow {
  id: string;
  crux_id: string;
  copy_id: string;
  candidate_id: string;
  phase: string;
  data: string;
}
export interface MergeState {
  merge?: MergeRow;
  copy?: CopyRow;
  candidate?: CopyRow;
  result?: { id: string; kind: string; meta: Record<string, any> };
  linked: boolean;
}
@Injectable()
export class TaskMergeRepository {
  constructor(private readonly db: DbService) {}
  async inspect(id: string, resultHead?: string) {
    try {
      const db = this.db.query();
      const merge = await db('task_merges').where({ id }).first();
      if (!merge) return success<MergeState>({ linked: false });
      const copy = await db('working_copies')
        .where({ id: merge.copy_id })
        .first();
      const candidate = await db('working_copies')
        .where({ id: merge.candidate_id })
        .first();
      const result = resultHead
        ? await db('cruxes')
            .where({ id: resultHead })
            .whereNull('deleted')
            .first()
        : undefined;
      const linked =
        !!resultHead &&
        !!(await db('dimensions')
          .where({
            source_id: merge.crux_id,
            target_id: resultHead,
            type: 'growth',
          })
          .whereNull('deleted')
          .first('id'));
      return success<MergeState>({ merge, copy, candidate, result, linked });
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
