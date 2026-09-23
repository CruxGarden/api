import {
  Injectable,
  ConflictException,
  InternalServerErrorException,
} from '@nestjs/common';
import { CruxGraphService } from '../crux/crux-graph.service';
import { TaskMergeRepository, MergeRow } from './task-merge.repository';
import {
  FileContentService,
  captureFileContentEdit,
} from './file-content.service';
import { FileContentRepository } from './file-content.repository';
import { DesktopContentStore } from './desktop-content';
import { isTaskContent, assertTaskContent } from './task-content';
import { isDeepStrictEqual } from 'util';
import type { GrowthSnapshotCreate } from './growth-content.service';

/** Durable review closure/finalization. Host file projection and Growth capture remain recoverable earlier steps. */
@Injectable()
export class TaskMergeService {
  constructor(
    private readonly repository: TaskMergeRepository,
    private readonly crux: CruxGraphService,
    private readonly content: FileContentService,
    private readonly contentRepository: FileContentRepository,
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

  async begin(id: string, expected: unknown, store?: DesktopContentStore) {
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
    const mainHead = await this.content.head(merge.crux_id);
    if (mainHead) {
      if (!store)
        throw new Error('Use the host content store to admit a file merge');
      const mainFiles = (
        await this.content.list(
          { cruxId: merge.crux_id, expected: mainHead },
          store,
        )
      ).entries;
      assertTaskContent(mainFiles, data.main);
      const candidateHead = await this.content.head(candidate.id);
      if (!candidateHead)
        throw new Error('The review candidate has no retained content');
      const candidateFiles = (
        await this.content.list(
          { cruxId: candidate.id, expected: candidateHead },
          store,
        )
      ).entries;
      assertTaskContent(candidateFiles, data.manifest);
      const taskHead = await this.content.head(copy.id);
      if (!taskHead) throw new Error('The Task has no retained content');
      assertTaskContent(
        (
          await this.content.list(
            { cruxId: copy.id, expected: taskHead },
            store,
          )
        ).entries,
        data.task,
      );
      const desired = candidateFiles.filter((file) => isTaskContent(file.path));
      const paths = new Set(desired.map((file) => file.path));
      const changes = [
        ...mainFiles
          .filter((file) => isTaskContent(file.path) && !paths.has(file.path))
          .map((file) => ({ remove: file.path })),
        ...desired.map((file) => ({ put: file })),
      ];
      const head = await this.content.edit(
        captureFileContentEdit({
          cruxId: merge.crux_id,
          expected: mainHead,
          changes,
        }),
        store,
        id,
      );
      await this.contentRepository.queueProjection(merge.crux_id, head);
    }
    return { id: copy.id, cruxId: merge.crux_id };
  }

  /** The only snapshot admitted during application is the checked merge result. */
  async admitSnapshot(
    input: GrowthSnapshotCreate,
    store: DesktopContentStore,
  ): Promise<string> {
    const evidence = input.meta?.merge as Record<string, unknown> | undefined;
    if (typeof evidence?.id !== 'string')
      throw new Error('Use the checked Task merge identity');
    const { merge, data, copy, candidate } = await this.ownedState(evidence.id);
    if (
      merge.phase !== 'applying' ||
      copy.phase !== 'ready' ||
      candidate.phase !== 'ready' ||
      input.cruxId !== merge.crux_id ||
      input.parentId !== data.targetHead ||
      evidence.copyId !== copy.id ||
      evidence.sourceHead !== data.sourceHead ||
      evidence.targetHead !== data.targetHead ||
      evidence.verifiedKey !== data.verifiedKey ||
      !isDeepStrictEqual(evidence.resolutions, data.resolutions)
    )
      throw new ConflictException(
        'The snapshot must describe the checked Task merge',
      );
    this.assertVerified(data);
    assertTaskContent(
      (
        await this.content.list(
          { cruxId: input.cruxId, expected: input.expected },
          store,
        )
      ).entries,
      data.manifest,
    );
    return merge.id;
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
