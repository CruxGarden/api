import {
  Injectable,
  ConflictException,
  InternalServerErrorException,
} from '@nestjs/common';
import { CruxGraphService } from '../crux/crux-graph.service';
import { TaskMergeRepository } from './task-merge.repository';

/** Final durable transition only. Host file projection and Growth capture remain recoverable earlier steps. */
@Injectable()
export class TaskMergeService {
  constructor(
    private readonly repository: TaskMergeRepository,
    private readonly crux: CruxGraphService,
  ) {}
  async complete(id: string, resultHead: string) {
    const inspected = await this.repository.inspect(id, resultHead);
    if (inspected.error)
      throw new InternalServerErrorException(inspected.error.message);
    const state = inspected.data!;
    const { merge, copy, candidate, result, linked } = state;
    if (!merge || !copy || !candidate)
      throw new ConflictException('The merge or its Task copies are missing');
    await this.crux.findById(merge.crux_id);
    const data = JSON.parse(merge.data);
    if (
      !data ||
      typeof data !== 'object' ||
      Array.isArray(data) ||
      data.id !== id ||
      data.cruxId !== merge.crux_id ||
      data.copyId !== copy.id ||
      data.candidateId !== candidate.id ||
      data.phase !== merge.phase ||
      copy.id === candidate.id ||
      copy.crux_id !== merge.crux_id ||
      candidate.crux_id !== merge.crux_id ||
      copy.role !== 'task' ||
      candidate.role !== 'review' ||
      !['ready', 'merged'].includes(copy.phase) ||
      !['ready', 'archived'].includes(candidate.phase)
    )
      throw new ConflictException(
        'The merge ownership or state does not match its journal',
      );
    for (const row of [copy, candidate])
      if (
        !Number.isSafeInteger(row.revision) ||
        row.revision < 0 ||
        row.revision >= Number.MAX_SAFE_INTEGER
      )
        throw new ConflictException('The Task revision is invalid');
    if (
      !linked ||
      result?.kind !== 'snapshot' ||
      result.meta?.merge?.id !== id ||
      result.meta?.merge?.copyId !== copy.id ||
      (result.meta.contentOwnerId !== undefined &&
        result.meta.contentOwnerId !== merge.crux_id)
    )
      throw new ConflictException(
        'The merge result must be preserved in this Crux’s Growth',
      );
    if (merge.phase === 'merged') {
      if (
        data.resultHead !== resultHead ||
        copy.phase !== 'merged' ||
        candidate.phase !== 'archived'
      )
        throw new ConflictException(
          'The completed merge has inconsistent state',
        );
    } else {
      if (
        merge.phase !== 'applying' ||
        (data.resultHead && data.resultHead !== resultHead)
      )
        throw new ConflictException('This merge is not awaiting completion');
      const saved = await this.repository.finish(state, {
        ...data,
        phase: 'merged',
        resultHead,
      });
      if (saved.error)
        throw new InternalServerErrorException(saved.error.message);
    }
    return { id: copy.id, cruxId: merge.crux_id };
  }
}
