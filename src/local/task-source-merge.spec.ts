import { createHash, randomUUID } from 'crypto';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { LocalGraphRuntime } from './graph-runtime';
import { DesktopContentStore } from './desktop-content';

describe('reviews returning work to its actual source Task', () => {
  let owner: LocalGraphRuntime, dir: string, store: DesktopContentStore;
  let main: string,
    target: string,
    worker: string,
    candidate: string,
    review: any;
  const row = (id: string) =>
    owner.get<any>('SELECT * FROM working_copies WHERE id = ?', [id]);
  const write = async (id: string, text: string) => {
    const bytes = Buffer.from(text);
    return owner.editFileContent(
      {
        cruxId: id,
        expected: await owner.fileContentHead(id),
        changes: [
          {
            put: {
              id: 'work',
              path: 'work.txt',
              fingerprint: createHash('sha256').update(bytes).digest('hex'),
              size: bytes.length,
              mode: 0o644,
              mimeType: 'text/plain',
              encoding: 'utf-8',
              attributes: {},
            },
            bytes,
          },
        ],
      },
      store,
    );
  };
  const manifest = async (id: string) =>
    Object.fromEntries(
      (
        await owner.listFileContent(
          {
            cruxId: id,
            expected: await owner.fileContentHead(id),
          },
          store,
        )
      ).entries.map((file) => [file.path, file]),
    );
  const create = async (source: string, role: 'task' | 'review' = 'task') => {
    const id = randomUUID();
    const meta =
      source === main
        ? (await owner.execute(({ crux }) => crux.findById(main))).meta
        : JSON.parse((await row(source)).meta);
    await owner.createWorkingCopy(
      {
        id,
        cruxId: main,
        taskId: randomUUID(),
        title: role,
        role,
        base: {
          ...(source !== main ? { sourceId: source } : {}),
          expected: await owner.fileContentHead(source),
          expectedMeta: meta,
        },
        meta: {
          messages: [
            {
              role: 'user',
              content: role === 'review' ? 'Review' : 'Own Task instruction',
            },
          ],
        },
      },
      store,
    );
    await owner.run("UPDATE working_copies SET phase = 'ready' WHERE id = ?", [
      id,
    ]);
    return id;
  };
  const saved = async () =>
    JSON.parse(
      (
        await owner.get<any>('SELECT data FROM task_merges WHERE id = ?', [
          review.id,
        ])
      ).data,
    );
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'source-merge-'));
    owner = await LocalGraphRuntime.create(join(dir, 'garden.db'));
    const blobs = new Map<string, Uint8Array>();
    store = {
      read: async (id) => blobs.get(id) ?? null,
      write: async (id, bytes) => {
        blobs.set(id, Uint8Array.from(bytes));
      },
    };
    main = await owner.createCrux({
      slug: randomUUID(),
      authorId: randomUUID(),
      homeId: randomUUID(),
      meta: { messages: [{ role: 'user', content: 'Main only' }] },
    });
    await write(main, 'Main stays unchanged');
    target = await create(main);
    await write(target, 'Parent Task starting state');
    worker = await create(target);
    candidate = await create(target, 'review');
    const base = await manifest(target);
    await write(worker, 'Worker result');
    await write(candidate, 'Worker result');
    const result = await manifest(worker);
    review = {
      id: randomUUID(),
      cruxId: main,
      targetId: target,
      copyId: worker,
      candidateId: candidate,
      phase: 'review',
      base,
      main: base,
      task: result,
      manifest: result,
      conflicts: [],
      resolutions: {},
      verifiedKey: JSON.stringify(
        Object.keys(result)
          .sort()
          .map((path) => [path, result[path].fingerprint, result[path].mode]),
      ),
    };
  });
  afterEach(async () => {
    await owner.close();
    rmSync(dir, { recursive: true, force: true });
  });
  it('inspects retained Task states and reads their exact files after further edits and restart', async () => {
    await owner.saveTaskReview(JSON.stringify(review), undefined, store);
    await owner.beginTaskMerge(review.id, JSON.stringify(await saved()), store);
    await owner.completeTaskMerge(review.id, store);
    const selection = { cruxId: main, id: review.id, part: 'result' as const };
    const retained = await owner.inspectTaskHistory(selection, store);
    expect(retained.entries.map((f) => f.path)).toEqual(['work.txt']);
    expect(
      retained.workspace.messages.some((m: any) => m.taskMergeId === review.id),
    ).toBe(true);
    const reads = jest.spyOn(store, 'read');
    await owner.inspectTaskHistory(selection, store);
    expect(
      reads.mock.calls.some(([fp]) => fp === retained.entries[0].fingerprint),
    ).toBe(false);
    reads.mockRestore();
    const original = await owner.readTaskHistoryFile(
      selection,
      retained.root,
      'work.txt',
      store,
    );
    await write(target, 'Later work');
    await owner.close();
    owner = await LocalGraphRuntime.open(join(dir, 'garden.db'));
    expect(await owner.inspectTaskHistory(selection, store)).toEqual(retained);
    expect(
      await owner.readTaskHistoryFile(
        selection,
        retained.root,
        'work.txt',
        store,
      ),
    ).toEqual(original);
    expect(Buffer.from(original!.bytes).toString()).not.toBe('Later work');
    for (const part of ['source', 'target'] as const)
      expect(
        (await owner.inspectTaskHistory({ ...selection, part }, store)).root,
      ).toBe((await saved())[`${part}State`].root);
    const base = await owner.inspectTaskHistory(
      { cruxId: main, id: worker, part: 'base' },
      store,
    );
    expect(base.root).toBe((await owner.workingCopyBase(worker, store)).root);
    expect(
      await owner.readTaskHistoryFile(
        selection,
        retained.root,
        'missing.txt',
        store,
      ),
    ).toBeNull();
    await expect(
      owner.readTaskHistoryFile(selection, '0'.repeat(64), 'work.txt', store),
    ).rejects.toThrow(/changed/);
    await expect(
      owner.readTaskHistoryFile(selection, retained.root, '../work.txt', store),
    ).rejects.toThrow(/path/);
  });

  it('refuses uncompleted, foreign and malformed history selection without reading blobs', async () => {
    await owner.saveTaskReview(JSON.stringify(review), undefined, store);
    const read = jest.spyOn(store, 'read');
    const selection = { cruxId: main, id: review.id, part: 'source' as const };
    await expect(owner.inspectTaskHistory(selection, store)).rejects.toThrow(
      /Completed/,
    );
    await expect(
      owner.inspectTaskHistory({ ...selection, cruxId: randomUUID() }, store),
    ).rejects.toThrow();
    await expect(
      owner.inspectTaskHistory(
        { ...selection, part: 'base', id: candidate },
        store,
      ),
    ).rejects.toThrow(/another Crux/);
    await expect(
      owner.inspectTaskHistory(
        { ...selection, part: 'anything' } as any,
        store,
      ),
    ).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
    read.mockRestore();
  });

  it('refuses corrupted retained file bytes instead of silently reading the live destination', async () => {
    await owner.saveTaskReview(JSON.stringify(review), undefined, store);
    await owner.beginTaskMerge(review.id, JSON.stringify(await saved()), store);
    await owner.completeTaskMerge(review.id, store);
    const selection = { cruxId: main, id: review.id, part: 'result' as const };
    const retained = await owner.inspectTaskHistory(selection, store);
    const fingerprint = retained.entries[0].fingerprint;
    const originalRead = store.read.bind(store);
    jest
      .spyOn(store, 'read')
      .mockImplementation((fp) =>
        fp === fingerprint
          ? Promise.resolve(Buffer.from('Corrupt'))
          : originalRead(fp),
      );
    await expect(
      owner.readTaskHistoryFile(selection, retained.root, 'work.txt', store),
    ).rejects.toThrow(/integrity|fingerprint|hash/i);
    jest.restoreAllMocks();
  });

  it('merges and summarizes only into the parent Task, retaining recovery state and no Growth', async () => {
    const mainBefore = {
      head: await owner.fileContentHead(main),
      meta: (await owner.execute(({ crux }) => crux.findById(main))).meta,
    };
    await owner.saveTaskReview(JSON.stringify(review), undefined, store);
    const admitted = await saved();
    expect(admitted.targetState.workspace.messages).toEqual(
      JSON.parse((await row(target)).meta).messages,
    );
    await owner.beginTaskMerge(review.id, JSON.stringify(admitted), store);
    await owner.close();
    owner = await LocalGraphRuntime.open(join(dir, 'garden.db'));
    await owner.completeTaskMerge(review.id, store);
    await owner.completeTaskMerge(review.id, store);
    const completed = await saved();
    expect(completed.phase).toBe('merged');
    expect(completed.resultState.root).toBe(
      (await owner.fileContentHead(target))!.root,
    );
    expect(
      JSON.parse((await row(target)).meta).messages.filter(
        (message: any) => message.taskMergeId === review.id,
      ),
    ).toHaveLength(1);
    expect((await row(target)).phase).toBe('ready');
    expect((await row(worker)).phase).toBe('merged');
    expect((await row(candidate)).phase).toBe('archived');
    expect({
      head: await owner.fileContentHead(main),
      meta: (await owner.execute(({ crux }) => crux.findById(main))).meta,
    }).toEqual(mainBefore);
    expect(
      await owner.all("SELECT id FROM dimensions WHERE type = 'growth'"),
    ).toEqual([]);
    await write(target, 'Later independent parent work');
    await owner.run('DELETE FROM edit_history');
    const graph = await owner.exportPrivateGraph(
      { roots: [main], includeMembers: false },
      store,
    );
    const destination = await LocalGraphRuntime.create(join(dir, 'copied.db'));
    try {
      const copy = await destination.importPrivateGraph(
        {
          requestId: randomUUID(),
          mode: 'copy',
          destination: { authorId: randomUUID(), homeId: randomUUID() },
          graph,
        },
        store,
        store,
      );
      const journal = JSON.parse(
        (
          await destination.get<any>(
            'SELECT data FROM task_merges WHERE id = ?',
            [copy.ids[review.id]],
          )
        ).data,
      );
      expect(journal.targetId).toBe(copy.ids[target]);
      expect(journal.resultState.root).toBe(completed.resultState.root);
      await destination.completeTaskMerge(copy.ids[review.id], store);
    } finally {
      await destination.close();
    }
  });
  it.each(['destination', 'candidate', 'closed'])(
    'refuses a mismatched %s before saving a review',
    async (fault) => {
      if (fault === 'destination') review.targetId = main;
      if (fault === 'candidate')
        review.candidateId = await create(main, 'review');
      if (fault === 'closed')
        await owner.run(
          "UPDATE working_copies SET phase = 'archived' WHERE id = ?",
          [target],
        );
      const before = await owner.fileContentHead(main);
      await expect(
        owner.saveTaskReview(JSON.stringify(review), undefined, store),
      ).rejects.toThrow();
      expect(
        await owner.get('SELECT id FROM task_merges WHERE id = ?', [review.id]),
      ).toBeUndefined();
      expect(await owner.fileContentHead(main)).toEqual(before);
    },
  );
  it.each(['files', 'conversation'])(
    'refuses stale destination %s at admission',
    async (fault) => {
      await owner.saveTaskReview(JSON.stringify(review), undefined, store);
      const original = await saved();
      if (fault === 'files') await write(target, 'New parent files');
      else
        await owner.updateWorkingCopyMeta(target, {
          messages: [{ role: 'user', content: 'New parent conversation' }],
        });
      await expect(
        owner.beginTaskMerge(review.id, JSON.stringify(original), store),
      ).rejects.toThrow();
      expect(await saved()).toEqual(original);
      expect((await row(worker)).phase).toBe('ready');
    },
  );
  it.each(['summary', 'journal', 'close destination'])(
    'recovers a refused %s without duplicate summaries or touching Main',
    async (fault) => {
      await owner.saveTaskReview(JSON.stringify(review), undefined, store);
      await owner.beginTaskMerge(
        review.id,
        JSON.stringify(await saved()),
        store,
      );
      const before = {
        target: await row(target),
        worker: await row(worker),
        candidate: await row(candidate),
        journal: await saved(),
      };
      if (fault === 'summary')
        await owner.run(
          `CREATE TRIGGER refuse BEFORE UPDATE ON working_copies WHEN NEW.id = '${target}' BEGIN SELECT RAISE(IGNORE); END`,
        );
      if (fault === 'journal')
        await owner.run(
          "CREATE TRIGGER refuse BEFORE UPDATE ON task_merges WHEN NEW.phase = 'merged' BEGIN SELECT RAISE(IGNORE); END",
        );
      if (fault === 'close destination')
        await owner.run(
          `CREATE TRIGGER refuse AFTER UPDATE ON task_merges WHEN NEW.phase = 'merged' BEGIN UPDATE working_copies SET phase = 'archived' WHERE id = '${target}'; END`,
        );
      await expect(owner.completeTaskMerge(review.id, store)).rejects.toThrow();
      expect({
        target: await row(target),
        worker: await row(worker),
        candidate: await row(candidate),
        journal: await saved(),
      }).toEqual(before);
      await owner.run('DROP TRIGGER refuse');
      await owner.close();
      owner = await LocalGraphRuntime.open(join(dir, 'garden.db'));
      await owner.completeTaskMerge(review.id, store);
      await owner.completeTaskMerge(review.id, store);
      expect(
        JSON.parse((await row(target)).meta).messages.filter(
          (message: any) => message.taskMergeId === review.id,
        ),
      ).toHaveLength(1);
      expect(
        (await owner.execute(({ crux }) => crux.findById(main))).meta.messages,
      ).toEqual([{ role: 'user', content: 'Main only' }]);
    },
  );
  it('retains a parent Task marked version in results and private Copy, without copying its transcript into the worker summary', async () => {
    const mark = await owner.createGrowthSnapshot(
      {
        cruxId: target,
        expected: await owner.fileContentHead(target),
        snapshotId: randomUUID(),
        parentId: null,
        meta: {
          messages: [{ role: 'user', content: 'Marked parent transcript' }],
        },
      },
      store,
    );
    await owner.updateWorkingCopyMeta(target, {
      settings: { activeBranch: mark.snapshot.id },
      messages: [{ role: 'user', content: 'Unmarked parent transcript' }],
    });
    // New work retains the marked parent as its boundary.
    worker = await create(target);
    candidate = await create(target, 'review');
    review = {
      ...review,
      copyId: worker,
      candidateId: candidate,
      main: await manifest(target),
      task: await manifest(worker),
      manifest: await manifest(candidate),
    };
    review.verifiedKey = JSON.stringify(
      Object.keys(review.manifest)
        .sort()
        .map((path) => [
          path,
          review.manifest[path].fingerprint,
          review.manifest[path].mode,
        ]),
    );
    await owner.saveTaskReview(JSON.stringify(review), undefined, store);
    await owner.beginTaskMerge(review.id, JSON.stringify(await saved()), store);
    await owner.completeTaskMerge(review.id, store);
    expect((await saved()).resultState.workspace.parentId).toBe(
      mark.snapshot.id,
    );
    const messages = JSON.parse((await row(target)).meta).messages;
    expect(messages[0].content).toBe('Unmarked parent transcript');
    expect(messages[1].content).not.toContain('Marked parent transcript');
    const graph = await owner.exportPrivateGraph(
      { roots: [main], includeMembers: false },
      store,
    );
    const destination = await LocalGraphRuntime.create(
      join(dir, 'marked-copy.db'),
    );
    try {
      const copied = await destination.importPrivateGraph(
        {
          requestId: randomUUID(),
          mode: 'copy',
          destination: { authorId: randomUUID(), homeId: randomUUID() },
          graph,
        },
        store,
        store,
      );
      await destination.completeTaskMerge(copied.ids[review.id], store);
      const corrupt = structuredClone(graph);
      corrupt.taskMerges[0].data.targetId = main;
      await expect(
        destination.importPrivateGraph(
          {
            requestId: randomUUID(),
            mode: 'copy',
            destination: { authorId: randomUUID(), homeId: randomUUID() },
            graph: corrupt,
          },
          store,
          store,
        ),
      ).rejects.toThrow();
    } finally {
      await destination.close();
    }
  });
});
