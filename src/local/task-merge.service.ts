import { TaskHistorySelection } from './task-history';
import { WorkingCopyService } from './working-copy.service';
import { workingCopyBaseSchema } from './working-copy-base';
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
import {
  WorkspaceStateService,
  RetainedWorkspaceState,
} from './workspace-state.service';
import { retainedWorkspaceSchema } from './edit-history';
import { FileManifest, FileEntry } from './file-manifest';

/** Durable review closure/finalization. Host file projection and Growth capture remain recoverable earlier steps. */
@Injectable()
export class TaskMergeService {
  constructor(
    private readonly repository: TaskMergeRepository,
    private readonly crux: CruxGraphService,
    private readonly content: FileContentService,
    private readonly contentRepository: FileContentRepository,
    private readonly workspace: WorkspaceStateService,
    private readonly copies: WorkingCopyService,
  ) {}
  private async historyState(
    input: TaskHistorySelection,
  ): Promise<RetainedWorkspaceState> {
    await this.crux.findById(input.cruxId);
    if (input.part === 'base') {
      return this.copies.inspectBaseState(input.id, input.cruxId);
    }
    const { merge, data } = await this.ownedState(input.id);
    if (merge.crux_id !== input.cruxId || merge.phase !== 'merged')
      throw new ConflictException('Completed Task history is unavailable');
    return retainedWorkspaceSchema.parse(
      data[`${input.part}State`],
    ) as RetainedWorkspaceState;
  }

  async inspectHistory(
    input: TaskHistorySelection,
    store: DesktopContentStore,
  ) {
    const state = await this.historyState(input);
    return {
      ...state,
      entries: await new FileManifest(store).entries(state.root),
    };
  }

  async readHistoryFile(
    input: TaskHistorySelection,
    root: string,
    path: string,
    store: DesktopContentStore,
  ) {
    const state = await this.historyState(input);
    if (state.root !== root)
      throw new ConflictException(
        'The selected Task history changed; reopen it',
      );
    return new FileManifest(store).readFile(state.root, path);
  }

  private async ownedState(
    id: string,
    options: { closing?: boolean; draft?: MergeRow } = {},
  ) {
    const inspected = await this.repository.inspect(id, options.draft);
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
    const base = workingCopyBaseSchema.parse(JSON.parse(copy.base_state));
    const candidateBase = workingCopyBaseSchema.parse(
      JSON.parse(candidate.base_state),
    );
    const targetId = base.sourceId ?? merge.crux_id;
    if (
      (data.targetId !== undefined && data.targetId !== targetId) ||
      (candidateBase.sourceId ?? merge.crux_id) !== targetId ||
      (targetId !== merge.crux_id &&
        (!state.target ||
          state.target.crux_id !== merge.crux_id ||
          state.target.role !== 'task'))
    )
      throw new ConflictException(
        'The review destination does not match its source Task.',
      );
    const target =
      targetId === merge.crux_id ? crux : await this.content.owner(targetId);
    for (const row of [copy, candidate])
      if (
        !Number.isSafeInteger(row.revision) ||
        row.revision < 0 ||
        row.revision >= Number.MAX_SAFE_INTEGER
      )
        throw new ConflictException('The Task revision is invalid');
    return { state, merge, copy, candidate, data, crux, target, targetId };
  }

  async save(
    next: Record<string, any>,
    expected: Record<string, any> | undefined,
    store: DesktopContentStore,
  ) {
    if (
      !next ||
      typeof next !== 'object' ||
      Array.isArray(next) ||
      next.phase !== 'review' ||
      ['id', 'cruxId', 'copyId', 'candidateId'].some(
        (key) => typeof next[key] !== 'string' || !next[key],
      ) ||
      ['base', 'main', 'task', 'manifest', 'resolutions'].some(
        (key) =>
          !next[key] ||
          typeof next[key] !== 'object' ||
          Array.isArray(next[key]),
      ) ||
      !Array.isArray(next.conflicts) ||
      next.resultHead !== undefined ||
      next.resultState !== undefined ||
      next.targetWorkspace !== undefined ||
      next.sourceHead !== undefined ||
      next.targetHead !== undefined
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
    const { state, merge, copy, candidate, data, targetId } =
      await this.ownedState(next.id, {
        draft: expected === undefined ? draft : undefined,
      });
    if (
      merge.phase !== 'review' ||
      copy.phase !== 'ready' ||
      candidate.phase !== 'ready' ||
      (state.target && state.target.phase !== 'ready')
    )
      throw new ConflictException('This review is no longer open for changes.');
    if (state.present && expected === undefined) {
      const original = { ...data };
      delete original.sourceState;
      delete original.targetState;
      if (next.targetId === undefined) delete original.targetId;
      if (
        JSON.stringify(data) !== JSON.stringify(next) &&
        JSON.stringify(original) !== JSON.stringify(next)
      )
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
    if (!state.present) {
      if (next.sourceState !== undefined || next.targetState !== undefined)
        throw new ConflictException('Review context is captured by the API.');
      const capture = async (cruxId: string, files: Record<string, any>) => {
        const head = await this.content.head(cruxId);
        if (!head)
          throw new ConflictException(
            'The reviewed workspace has no retained content',
          );
        const captured = await this.workspace.read(
          { cruxId, expected: head },
          store,
        );
        assertTaskContent(
          await new FileManifest(store).entries(captured.root),
          files,
        );
        return captured;
      };
      next = {
        ...next,
        targetId,
        sourceState: await capture(copy.id, next.task),
        targetState: await capture(targetId, next.main),
      };
    }
    const saved = await this.repository.saveReview(state, next);
    if (saved.error)
      throw new InternalServerErrorException(saved.error.message);
    return { id: copy.id, cruxId: merge.crux_id };
  }

  async begin(id: string, expected: unknown, store?: DesktopContentStore) {
    const { state, merge, copy, candidate, data, targetId } =
      await this.ownedState(id);
    if (
      merge.phase !== 'review' ||
      copy.phase !== 'ready' ||
      candidate.phase !== 'ready' ||
      (state.target && state.target.phase !== 'ready') ||
      JSON.stringify(data) !== JSON.stringify(expected)
    )
      throw new ConflictException(
        'This review changed. Prepare or check it again before merging.',
      );
    this.assertVerified(data);
    const inspected = await this.repository.admissionContext(merge.crux_id);
    if (inspected.error)
      throw new InternalServerErrorException(inspected.error.message);
    const { pending } = inspected.data!;
    if (pending)
      throw new ConflictException(
        'Finish recovering the existing merge before starting another.',
      );
    if (!store)
      throw new Error('Use the host content store to admit a file merge');
    for (const [label, cruxId, retained] of [
      ['Task', copy.id, data.sourceState],
      ['destination', targetId, data.targetState],
    ] as const) {
      const expectedState = retainedWorkspaceSchema.parse(retained);
      const head = await this.content.head(cruxId);
      if (!head)
        throw new ConflictException(
          `The ${label} workspace has no retained content after review. Prepare a new review.`,
        );
      const live = await this.workspace.read({ cruxId, expected: head }, store);
      const drift = describeWorkspaceDrift(
        expectedState,
        live,
        await this.taskContentDrift(expectedState.root, live.root, store),
      );
      if (drift)
        throw new ConflictException(
          `The ${label} workspace changed after review (${drift}). Prepare a new review.`,
        );
    }
    const saved = await this.repository.begin(state, {
      ...data,
      phase: 'applying',
    });
    if (saved.error)
      throw new InternalServerErrorException(saved.error.message);
    const mainHead = await this.content.head(targetId);
    if (mainHead) {
      if (!store)
        throw new Error('Use the host content store to admit a file merge');
      const mainFiles = (
        await this.content.list({ cruxId: targetId, expected: mainHead }, store)
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
          cruxId: targetId,
          expected: mainHead,
          changes,
        }),
        store,
        id,
      );
      await this.contentRepository.queueProjection(targetId, head);
    }
    return { id: copy.id, cruxId: merge.crux_id };
  }

  /** The review covers Task content only. Housekeeping the review excludes by design
   * (the thumbnail, a toolchain install, `.crux`, AGENTS.md) may move the head root
   * after the check without changing what merges; name the reviewed files that did. */
  private async taskContentDrift(
    expectedRoot: string,
    liveRoot: string,
    store: DesktopContentStore,
  ): Promise<string> {
    if (expectedRoot === liveRoot) return '';
    const manifest = new FileManifest(store);
    const changed = changedTaskContent(
      await manifest.entries(expectedRoot),
      await manifest.entries(liveRoot),
    );
    if (!changed.length) return '';
    const shown = changed.slice(0, 3).join(', ');
    return `files differ: ${shown}${changed.length > 3 ? ` and ${changed.length - 3} more` : ''}`;
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

  async complete(id: string, store: DesktopContentStore) {
    const { state, merge, copy, candidate, data, target, targetId } =
      await this.ownedState(id);
    if (merge.phase === 'merged') {
      const result = retainedWorkspaceSchema.parse(
        data.resultState,
      ) as RetainedWorkspaceState;
      if (copy.phase !== 'merged' || candidate.phase !== 'archived')
        throw new ConflictException(
          'The completed merge has inconsistent state',
        );
      await this.workspace.assertContext(targetId, result.workspace);
      await new FileManifest(store).verify(result.root);
      return { id: copy.id, cruxId: merge.crux_id };
    }
    if (
      merge.phase !== 'applying' ||
      copy.phase !== 'ready' ||
      candidate.phase !== 'ready' ||
      (state.target && state.target.phase !== 'ready')
    )
      throw new ConflictException('This merge is not awaiting completion');
    this.assertVerified(data);
    const head = await this.content.head(targetId);
    if (!head) throw new ConflictException('The merge has no retained content');
    // Admission checks the pending projection and permits only this applying journal.
    const before = await this.workspace.read(
      { cruxId: targetId, expected: head },
      store,
      target.meta,
      id,
    );
    const drift = describeWorkspaceDrift(
      { workspace: retainedWorkspaceSchema.parse(data.targetState).workspace },
      { workspace: before.workspace },
    );
    if (drift)
      throw new ConflictException(
        `The destination’s conversation changed during the merge (${drift}). Keep it safe before resuming.`,
      );
    assertTaskContent(
      await new FileManifest(store).entries(before.root),
      data.manifest,
    );
    const source = retainedWorkspaceSchema.parse(data.sourceState);
    await new FileManifest(store).verify(source.root);
    const segments: any[][] = [source.workspace.messages];
    const seen = new Set<string>();
    let tip = source.workspace.parentId;
    while (tip) {
      if (seen.has(tip))
        throw new ConflictException('Task conversation has cyclic ancestry');
      seen.add(tip);
      await this.workspace.assertContext(copy.id, {
        parentId: tip,
        messages: [],
        entryFile: null,
      });
      const node = await this.crux.findById(tip);
      if (node.meta?.contentOwnerId !== copy.id) {
        if (
          tip !==
          workingCopyBaseSchema.parse(JSON.parse(copy.base_state)).workspace
            .parentId
        )
          throw new ConflictException(
            'The reviewed conversation belongs to another Task',
          );
        break;
      }
      if (node.kind !== 'snapshot' || !Array.isArray(node.meta.messages ?? []))
        throw new ConflictException('Task conversation is unavailable');
      segments.unshift(node.meta.messages ?? []);
      tip = node.meta.parentCruxId;
    }
    const collaboration = segments
      .flat()
      .map(
        (message) =>
          `**${message.role === 'user' ? 'You' : 'Collaborator'}**\n\n${message.content ?? ''}`,
      )
      .join('\n\n');
    const summary = {
      role: 'assistant',
      taskMergeId: id,
      content: `Merged task: ${copy.title ?? 'Task'}.\n\n${collaboration ? `Task Collaboration\n\n${collaboration}` : 'Its Collaboration is preserved in the Task.'}`,
      timestamp: new Date().toISOString(),
    };
    const meta = {
      ...target.meta,
      messages: [...before.workspace.messages, summary],
    };
    if (state.target) await this.copies.updateMeta(targetId, meta);
    else await this.crux.update(targetId, { meta });
    const resultState = await this.workspace.read(
      { cruxId: targetId, expected: head },
      store,
      meta,
      id,
    );
    const saved = await this.repository.transition(
      state,
      { ...data, phase: 'merged', resultState },
      true,
    );
    if (saved.error)
      throw new InternalServerErrorException(saved.error.message);
    // A journal/copy trigger must not undo the already-written Collaboration or content.
    if (
      !isDeepStrictEqual((await this.content.owner(targetId)).meta, meta) ||
      !isDeepStrictEqual(await this.content.head(targetId), head)
    )
      throw new InternalServerErrorException(
        'The merge result did not persist',
      );
    return { id: copy.id, cruxId: merge.crux_id };
  }
}

/** Paths whose reviewed content (not row timestamps) differs between two file states. */
export function changedTaskContent(
  before: FileEntry[],
  after: FileEntry[],
): string[] {
  const same = (a: FileEntry, b: FileEntry) =>
    a.fingerprint === b.fingerprint &&
    a.mode === b.mode &&
    a.encoding === b.encoding &&
    a.mimeType === b.mimeType &&
    a.size === b.size;
  const was = new Map(
    before.filter((e) => isTaskContent(e.path)).map((e) => [e.path, e]),
  );
  const now = new Map(
    after.filter((e) => isTaskContent(e.path)).map((e) => [e.path, e]),
  );
  return [...new Set([...was.keys(), ...now.keys()])]
    .filter((path) => {
      const a = was.get(path),
        b = now.get(path);
      return !a || !b || !same(a, b);
    })
    .sort();
}

type WorkspaceDriftInput = {
  workspace?: {
    parentId?: string | null;
    messages?: unknown[];
    entryFile?: string | null;
  };
};

/** Name what moved between the retained review state and the live workspace, or '' when nothing did. */
export function describeWorkspaceDrift(
  expected: WorkspaceDriftInput,
  actual: WorkspaceDriftInput,
  files = '',
): string {
  const drift: string[] = [];
  const show = (value: unknown) =>
    value === null || value === undefined ? 'none' : String(value);
  if (files) drift.push(files);
  const was = expected.workspace ?? {};
  const now = actual.workspace ?? {};
  if ((was.parentId ?? null) !== (now.parentId ?? null))
    drift.push(
      `Growth tip differs (${show(was.parentId)} → ${show(now.parentId)})`,
    );
  if ((was.entryFile ?? null) !== (now.entryFile ?? null))
    drift.push(
      `entry file differs (${show(was.entryFile)} → ${show(now.entryFile)})`,
    );
  const before = was.messages ?? [];
  const after = now.messages ?? [];
  if (!isDeepStrictEqual(before, after)) {
    if (before.length !== after.length)
      drift.push(
        `messages differ (${before.length} → ${after.length} entries)`,
      );
    else {
      const index = before.findIndex(
        (message, i) => !isDeepStrictEqual(message, after[i]),
      );
      drift.push(`messages differ (entry ${index + 1} of ${before.length})`);
    }
  }
  return drift.join('; ');
}
