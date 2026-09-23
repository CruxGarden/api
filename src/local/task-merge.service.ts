import {
  Injectable,
  ConflictException,
  InternalServerErrorException,
} from '@nestjs/common';
import { CruxGraphService } from '../crux/crux-graph.service';
import { TaskMergeRepository, MergeRow } from './task-merge.repository';

/** Durable review closure/finalization. Host file projection and Growth capture remain recoverable earlier steps. */
@Injectable()
export class TaskMergeService {
  constructor(
    private readonly repository: TaskMergeRepository,
    private readonly crux: CruxGraphService,
  ) {}
  private async ownedState(
    id: string,
    options: { resultHead?: string; closing?: boolean; draft?: MergeRow } = {},
  ) {
    const inspected = await this.repository.inspect(
      id,
      options.resultHead,
      options.draft,
    );
    if (inspected.error)
      throw new InternalServerErrorException(inspected.error.message);
    const state = inspected.data!;
    const { merge, copy, candidate } = state;
    if (!merge || !copy || !candidate)
      throw new ConflictException('The merge or its Task copies are missing');
    const crux = await this.crux.findById(merge.crux_id);
    const data = JSON.parse(merge.data);
    if (
      !data ||
      typeof data !== 'object' ||
      Array.isArray(data) ||
      data.id !== id ||
      data.cruxId !== merge.crux_id ||
      data.copyId !== copy.id ||
      data.candidateId !== candidate.id ||
      // Old Garden restore cancelled only the indexed phase. Only closure may
      // repair that exact shape; applying journals still require recovery.
      (data.phase !== merge.phase &&
        !(
          options.closing &&
          merge.phase === 'cancelled' &&
          data.phase === 'review'
        )) ||
      copy.id === candidate.id ||
      copy.crux_id !== merge.crux_id ||
      candidate.crux_id !== merge.crux_id ||
      copy.role !== 'task' ||
      candidate.role !== 'review' ||
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
    return { state, merge, copy, candidate, data, crux };
  }

  async save(next: Record<string, any>, expected?: Record<string, any>) {
    if (
      !next ||
      typeof next !== 'object' ||
      Array.isArray(next) ||
      next.phase !== 'review' ||
      [
        'id',
        'cruxId',
        'copyId',
        'candidateId',
        'sourceHead',
        'targetHead',
      ].some((key) => typeof next[key] !== 'string' || !next[key]) ||
      ['base', 'main', 'task', 'manifest', 'resolutions'].some(
        (key) =>
          !next[key] ||
          typeof next[key] !== 'object' ||
          Array.isArray(next[key]),
      ) ||
      !Array.isArray(next.conflicts) ||
      next.resultHead !== undefined
    )
      throw new ConflictException('Use a complete unapplied Task review.');
    const draft: MergeRow = {
      id: next.id,
      crux_id: next.cruxId,
      copy_id: next.copyId,
      candidate_id: next.candidateId,
      phase: 'review',
      data: JSON.stringify(next),
    };
    const { state, merge, copy, candidate, data } = await this.ownedState(
      next.id,
      { draft: expected === undefined ? draft : undefined },
    );
    if (
      merge.phase !== 'review' ||
      copy.phase !== 'ready' ||
      candidate.phase !== 'ready'
    )
      throw new ConflictException('This review is no longer open for changes.');
    if (state.present && expected === undefined) {
      if (JSON.stringify(data) !== JSON.stringify(next))
        throw new ConflictException('This review already exists.');
      return { id: copy.id, cruxId: merge.crux_id }; // Lost-response retry, no timestamp/revision change.
    }
    if (expected !== undefined) {
      if (JSON.stringify(data) !== JSON.stringify(expected))
        throw new ConflictException(
          'This review changed while you were checking it. Check the current review again.',
        );
      const editable = new Set([
        'manifest',
        'conflicts',
        'resolutions',
        'verifiedKey',
        'verificationLog',
        'previewUrl',
      ]);
      for (const key of new Set([...Object.keys(data), ...Object.keys(next)]))
        if (
          !editable.has(key) &&
          JSON.stringify(data[key]) !== JSON.stringify(next[key])
        )
          throw new ConflictException(
            'The review’s ownership, history and retained evidence cannot be replaced.',
          );
    }
    if (next.verifiedKey !== undefined) this.assertVerified(next);
    const availability = await this.repository.reviewAvailable(
      merge.crux_id,
      candidate.id,
      merge.id,
    );
    if (availability.error)
      throw new InternalServerErrorException(availability.error.message);
    if (!availability.data!.available)
      throw new ConflictException(
        'Finish the existing merge or prepare a separate review candidate.',
      );
    const saved = await this.repository.saveReview(state, next);
    if (saved.error)
      throw new InternalServerErrorException(saved.error.message);
    return { id: copy.id, cruxId: merge.crux_id };
  }

  async begin(id: string, expected: unknown) {
    const { state, merge, copy, candidate, data, crux } =
      await this.ownedState(id);
    if (
      merge.phase !== 'review' ||
      copy.phase !== 'ready' ||
      candidate.phase !== 'ready' ||
      JSON.stringify(data) !== JSON.stringify(expected)
    )
      throw new ConflictException(
        'This review changed. Prepare or check it again before merging.',
      );
    this.assertVerified(data);
    const inspected = await this.repository.admissionContext(
      merge.crux_id,
      copy.id,
    );
    if (inspected.error)
      throw new InternalServerErrorException(inspected.error.message);
    const { pending, growths } = inspected.data!;
    if (pending)
      throw new ConflictException(
        'Finish recovering the existing merge before starting another.',
      );
    for (const [ownerId, expectedHead, meta] of [
      [merge.crux_id, data.targetHead, crux.meta],
      [copy.id, data.sourceHead, copy.meta],
    ] as const) {
      const owned = growths.filter((row) => row.source_id === ownerId);
      const active = meta?.settings?.activeBranch;
      const latestWeight = Math.max(...owned.map((row) => row.weight ?? 0));
      const tips = active
        ? owned.filter((row) => row.target_id === active)
        : owned.filter((row) => (row.weight ?? 0) === latestWeight);
      if (
        !expectedHead ||
        !tips.length ||
        tips.some((row) => row.target_id !== expectedHead) ||
        tips.some(
          (row) =>
            row.meta?.contentOwnerId !== undefined &&
            row.meta.contentOwnerId !== ownerId,
        )
      )
        throw new ConflictException(
          'Growth changed after review. Prepare a new review.',
        );
    }
    const saved = await this.repository.begin(state, {
      ...data,
      phase: 'applying',
    });
    if (saved.error)
      throw new InternalServerErrorException(saved.error.message);
    return { id: copy.id, cruxId: merge.crux_id };
  }

  private assertVerified(data: Record<string, any>) {
    if (
      !Array.isArray(data.conflicts) ||
      data.conflicts.length ||
      !data.manifest ||
      typeof data.manifest !== 'object' ||
      Array.isArray(data.manifest)
    )
      throw new ConflictException(
        'Check the resolved candidate before merging.',
      );
    const paths = Object.keys(data.manifest).sort();
    if (
      paths.some(
        (path) =>
          !data.manifest[path] ||
          typeof data.manifest[path].fingerprint !== 'string' ||
          !data.manifest[path].fingerprint ||
          !Number.isSafeInteger(data.manifest[path].mode),
      ) ||
      data.verifiedKey !==
        JSON.stringify(
          paths.map((path) => [
            path,
            data.manifest[path].fingerprint,
            data.manifest[path].mode,
          ]),
        )
    )
      throw new ConflictException(
        'Check the resolved candidate before merging.',
      );
  }

  async release(id: string) {
    const { state, merge, candidate, copy, data } = await this.ownedState(id, {
      closing: true,
    });
    if (merge.phase === 'applying')
      throw new ConflictException(
        'Finish recovering this merge before closing its review.',
      );
    if (
      !['review', 'cancelled', 'merged'].includes(merge.phase) ||
      (merge.phase === 'merged' && copy.phase !== 'merged')
    )
      throw new ConflictException('The review has inconsistent state');
    const cancelled = { ...data, phase: 'cancelled' };
    delete cancelled.previewUrl;
    const saved = await this.repository.transition(
      state,
      merge.phase === 'merged' ? data : cancelled,
      false,
    );
    if (saved.error)
      throw new InternalServerErrorException(saved.error.message);
    return { id: candidate.id, cruxId: merge.crux_id };
  }

  async complete(id: string, resultHead: string) {
    const { state, merge, copy, candidate, data } = await this.ownedState(id, {
      resultHead,
    });
    const { result, linked } = state;
    if (!['ready', 'merged'].includes(copy.phase))
      throw new ConflictException('The source Task is not awaiting a merge');
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
      const saved = await this.repository.transition(
        state,
        {
          ...data,
          phase: 'merged',
          resultHead,
        },
        true,
      );
      if (saved.error)
        throw new InternalServerErrorException(saved.error.message);
    }
    return { id: copy.id, cruxId: merge.crux_id };
  }
}
