import { createHash, randomUUID } from 'crypto';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { LocalGraphRuntime, LocalGraphChange } from './graph-runtime';
import { DesktopContentStore } from './desktop-content';
import { FileContentHead } from './file-content.repository';
import { inspectDesktopManifestRecovery } from './desktop-recovery';

describe('manifest-backed Growth commands', () => {
  let dir: string;
  let owner: LocalGraphRuntime;
  let id: string;
  let head: FileContentHead;
  let objects: Map<string, Uint8Array>;
  let store: DesktopContentStore;
  const put = (text: string) => {
    const bytes = Buffer.from(text);
    return {
      put: {
        id: 'file',
        path: 'hello.txt',
        fingerprint: createHash('sha256').update(bytes).digest('hex'),
        size: bytes.length,
        mimeType: 'text/plain',
        encoding: 'utf-8',
        mode: 0o644,
        attributes: { custom: { keep: true } },
      },
      bytes,
    };
  };
  const request = () => ({
    cruxId: id,
    expected: { root: head.root, revision: head.revision },
    snapshotId: randomUUID(),
    parentId: null as string | null,
    title: 'Checkpoint',
    meta: {
      messages: [{ role: 'user', content: 'Keep this conversation' }],
      settings: { entryFile: 'hello.txt' },
      cumulativeMessageCount: 1,
    },
    dimensionMeta: { label: 'A moment', appChanges: { runtime: false } },
  });
  const selection = () => ({
    cruxId: id,
    expected: { root: head.root, revision: head.revision },
  });
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'growth-content-'));
    objects = new Map();
    store = {
      read: async (fp) => objects.get(fp) ?? null,
      write: async (fp, bytes) => {
        objects.set(fp, Uint8Array.from(bytes));
      },
    };
    owner = await LocalGraphRuntime.create(join(dir, 'garden.db'));
    id = await owner.createCrux({
      title: 'Main',
      slug: randomUUID(),
      authorId: randomUUID(),
      homeId: randomUUID(),
    });
    head = await owner.editFileContent(
      { cruxId: id, expected: null, changes: [put('First\0version')] },
      store,
    );
  });
  afterEach(async () => {
    await owner.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads an unmarked workspace state without Growth or recovery writes, and refuses a changed conversation', async () => {
    await owner.createGrowthSnapshot(request(), store);
    const meta = {
      messages: [{ role: 'user', content: 'Unmarked direction' }],
      settings: { activeBranch: null, entryFile: 'hello.txt' },
    };
    await owner.updateCrux(id, { meta });
    const bytesBefore = objects.size;
    const state = await owner.execute(({ workspaceState }) =>
      workspaceState.read(selection(), store, meta),
    );
    expect(state).toEqual({
      root: head.root,
      workspace: {
        parentId: null,
        messages: meta.messages,
        entryFile: 'hello.txt',
      },
    });
    (state.workspace.messages[0] as any).content = 'Mutated returned value';
    const again = await owner.execute(({ workspaceState }) =>
      workspaceState.read(selection(), store, meta),
    );
    expect(again.workspace.messages).toEqual(meta.messages);
    expect(objects.size).toBe(bytesBefore);
    expect((await owner.listEditHistory(id)).checkpoints).toEqual([]);
    expect(
      await owner.all("SELECT id FROM dimensions WHERE type = 'growth'"),
    ).toHaveLength(1);
    await owner.updateCrux(id, {
      meta: {
        ...meta,
        messages: [...meta.messages, { role: 'user', content: 'New thought' }],
      },
    });
    await expect(
      owner.execute(({ workspaceState }) =>
        workspaceState.read(selection(), store, meta),
      ),
    ).rejects.toThrow('workspace changed');
  });

  it('retains a Task base, edits and snapshots its independent content, and reopens both owners', async () => {
    const base = await owner.createGrowthSnapshot(request(), store);
    const taskId = randomUUID();
    await owner.createWorkingCopy({
      id: taskId,
      cruxId: id,
      taskId: randomUUID(),
      title: 'Independent work',
      baseSnapshotId: base.snapshot.id,
      role: 'task',
      meta: {},
    });
    const taskHead = await owner.fileContentHead(taskId);
    expect(taskHead).toEqual({ ...head, cruxId: taskId, revision: 1 });
    const edited = await owner.editFileContent(
      { cruxId: taskId, expected: taskHead, changes: [put('Task edits')] },
      store,
    );
    const taskSnapshot = await owner.createGrowthSnapshot(
      {
        cruxId: taskId,
        expected: edited,
        snapshotId: randomUUID(),
        parentId: base.snapshot.id,
        meta: { messages: [{ role: 'user', content: 'Task conversation' }] },
      },
      store,
    );
    expect(taskSnapshot.snapshot.meta?.contentOwnerId).toBe(taskId);
    expect(taskSnapshot.snapshot.meta?.parentCruxId).toBe(base.snapshot.id);
    expect(taskSnapshot.growth.sourceId).toBe(taskId);
    expect(await owner.fileContentHead(id)).toEqual(head);
    await owner.close();
    owner = await LocalGraphRuntime.open(join(dir, 'garden.db'));
    for (const [ownerId, expected, text] of [
      [id, head, 'First\0version'],
      [taskId, edited, 'Task edits'],
      [taskSnapshot.snapshot.id, taskSnapshot.head, 'Task edits'],
    ] as const) {
      const file = await owner.readFileContent(
        { cruxId: ownerId, expected, path: 'hello.txt' },
        store,
      );
      expect(Buffer.from(file!.bytes).toString()).toBe(text);
    }
    expect(await owner.all('SELECT * FROM artifacts')).toEqual([]);
  });

  it('restores workspace state with a durable projection that survives refusal and restart', async () => {
    const base = await owner.createGrowthSnapshot(request(), store);
    head = await owner.editFileContent(
      { cruxId: id, expected: head, changes: [put('Current work')] },
      store,
    );
    await owner.updateCrux(id, {
      meta: {
        projectFolder: '/owned/project',
        messages: [{ role: 'user', content: 'Current conversation' }],
        settings: { entryFile: 'current.txt', keep: true },
        extension: { keep: true },
      },
    });
    const before = await owner.execute(({ crux }) => crux.findById(id));
    const restore = await owner.restoreGrowthContent(
      {
        safety: selection(),
        target: { cruxId: base.snapshot.id, expected: base.head },
        workspace: { expectedMeta: before.meta, messages: [] },
      } as any,
      store,
    );
    const state = await owner.execute(({ crux }) => crux.findById(id));
    expect(state.meta.settings).toEqual({
      entryFile: 'hello.txt',
      keep: true,
      activeBranch: base.snapshot.id,
    });
    expect(state.meta.messages).toEqual([]);
    expect(state.meta.extension).toEqual({ keep: true });
    await expect(owner.updateCrux(id, { meta: before.meta })).rejects.toThrow(
      'projection',
    );
    expect((await owner.execute(({ crux }) => crux.findById(id))).meta).toEqual(
      state.meta,
    );
    await expect(
      owner.editFileContent(
        { cruxId: id, expected: restore.head, changes: [put('Too early')] },
        store,
      ),
    ).rejects.toThrow('projection');
    const apply = jest.fn(async () => {
      throw new Error('Disk unavailable');
    });
    await expect(
      (owner as any).finishContentProjection(id, store, apply),
    ).rejects.toThrow('Disk unavailable');
    await owner.close();
    owner = await LocalGraphRuntime.open(join(dir, 'garden.db'));
    const retry = jest.fn(async (folder, entries) => {
      expect(folder).toBe('/owned/project');
      expect(entries).toEqual([put('First\0version').put]);
    });
    await (owner as any).finishContentProjection(id, store, retry);
    expect(retry).toHaveBeenCalledTimes(1);
    await (owner as any).finishContentProjection(id, store, retry);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(
      (
        await owner.editFileContent(
          { cruxId: id, expected: restore.head, changes: [put('Next edit')] },
          store,
        )
      ).revision,
    ).toBe(restore.head.revision + 1);
  });

  it.each([
    'none',
    'unmarked Task',
    'journal abort',
    'journal ignore',
    'reverse metadata',
    'reverse task',
    'foreign copy',
    'changed conversation',
    'corrupt result',
    'foreign ancestry',
    'unlinked transcript',
    'deleted transcript',
    'missing transcript source',
  ])(
    'retains a Task result outside Growth with restart and %s',
    async (failure) => {
      const base = await owner.createGrowthSnapshot(request(), store);
      const copies: string[] = [];
      const taskFile = put('Reviewed work');
      for (const role of ['task', 'review'] as const) {
        const copyId = randomUUID();
        copies.push(copyId);
        await owner.createWorkingCopy({
          id: copyId,
          cruxId: id,
          taskId: randomUUID(),
          title: role,
          baseSnapshotId: base.snapshot.id,
          role,
          meta: {},
        });
        await owner.prepareWorkingCopyFolder(
          copyId,
          0,
          () => `/owned/${copyId}`,
        );
        await owner.finishWorkingCopySetup(copyId, 1, 'ready');
        await owner.editFileContent(
          {
            cruxId: copyId,
            expected: await owner.fileContentHead(copyId),
            changes: [taskFile],
          },
          store,
        );
      }
      const [copyId, candidateId] = copies;
      const task = await owner.createGrowthSnapshot(
        {
          ...request(),
          cruxId: copyId,
          expected: (await owner.fileContentHead(copyId))!,
          parentId: base.snapshot.id,
        },
        store,
      );
      if (failure === 'unmarked Task') {
        await owner.run('DELETE FROM dimensions WHERE target_id = ?', [
          task.snapshot.id,
        ]);
        await owner.run('DELETE FROM file_content_heads WHERE crux_id = ?', [
          task.snapshot.id,
        ]);
        await owner.run('DELETE FROM cruxes WHERE id = ?', [task.snapshot.id]);
        await owner.updateWorkingCopyMeta(copyId, {
          settings: { activeBranch: base.snapshot.id },
          messages: [{ role: 'user', content: 'Unmarked Task conversation' }],
        });
      }
      const asManifest = (text: string) => {
        const { fingerprint, mode, encoding, mimeType, size } = put(text).put;
        return { 'hello.txt': { fingerprint, mode, encoding, mimeType, size } };
      };
      const mergeId = randomUUID();
      let review: any = {
        id: mergeId,
        cruxId: id,
        copyId,
        candidateId,
        phase: 'review',
        base: asManifest('First\0version'),
        main: asManifest('First\0version'),
        task: asManifest('Reviewed work'),
        manifest: asManifest('Reviewed work'),
        conflicts: [],
        resolutions: {},
        verifiedKey: JSON.stringify([
          ['hello.txt', taskFile.put.fingerprint, 0o644],
        ]),
      };
      const instructions = put('Private Main guidance');
      instructions.put.path = 'AGENTS.md';
      instructions.put.id = 'main-guidance';
      head = await owner.editFileContent(
        { cruxId: id, expected: head, changes: [instructions] },
        store,
      );
      await owner.updateCrux(id, { meta: { projectFolder: '/owned/main' } });
      await owner.saveTaskReview(JSON.stringify(review), undefined, store);
      review = JSON.parse(
        (
          await owner.get<any>('SELECT data FROM task_merges WHERE id = ?', [
            mergeId,
          ])
        ).data,
      );
      expect(review.sourceState.root).toBe(
        (await owner.fileContentHead(copyId))!.root,
      );
      expect(review.sourceHead).toBeUndefined();
      expect(review.targetHead).toBeUndefined();
      await (owner.beginTaskMerge as any)(
        mergeId,
        JSON.stringify(review),
        store,
      );
      const mergedHead = (await owner.fileContentHead(id))!;
      expect(mergedHead.root).not.toBe(
        (await owner.fileContentHead(candidateId))!.root,
      );
      await expect(
        owner.editFileContent(
          { cruxId: id, expected: mergedHead, changes: [put('Not reviewed')] },
          store,
        ),
      ).rejects.toThrow();
      await owner.close();
      owner = await LocalGraphRuntime.open(join(dir, 'garden.db'));
      const apply = jest.fn(async (folder, entries) => {
        expect(folder).toBe('/owned/main');
        expect(entries).toEqual([instructions.put, taskFile.put]);
      });
      await owner.finishContentProjection(id, store, apply);
      expect(apply).toHaveBeenCalledTimes(1);
      const growthBefore = await owner.all(
        "SELECT * FROM dimensions WHERE type = 'growth'",
      );
      const state = async () => ({
        main: await owner.get<any>('SELECT * FROM cruxes WHERE id = ?', [id]),
        copies: await owner.all('SELECT * FROM working_copies ORDER BY id'),
        journal: await owner.get<any>(
          'SELECT * FROM task_merges WHERE id = ?',
          [mergeId],
        ),
      });
      const before = await state();
      let repair = async () => {};
      if (failure === 'journal abort' || failure === 'journal ignore') {
        const action =
          failure === 'journal abort' ? "ABORT, 'Journal refused'" : 'IGNORE';
        await owner.run(
          `CREATE TRIGGER refuse_finish BEFORE UPDATE ON task_merges WHEN NEW.phase = 'merged' BEGIN SELECT RAISE(${action}); END`,
        );
        repair = async () => {
          await owner.run('DROP TRIGGER refuse_finish');
        };
      } else if (failure === 'reverse metadata') {
        await owner.run(
          `CREATE TRIGGER reverse_meta AFTER UPDATE ON task_merges WHEN NEW.phase = 'merged' BEGIN UPDATE cruxes SET meta = '{}' WHERE id = '${id}'; END`,
        );
        repair = async () => {
          await owner.run('DROP TRIGGER reverse_meta');
        };
      } else if (failure === 'reverse task') {
        await owner.run(
          `CREATE TRIGGER reverse_task AFTER UPDATE ON task_merges WHEN NEW.phase = 'merged' BEGIN UPDATE working_copies SET phase = 'ready' WHERE id = '${copyId}'; END`,
        );
        repair = async () => {
          await owner.run('DROP TRIGGER reverse_task');
        };
      } else if (failure === 'foreign copy') {
        await owner.run('UPDATE working_copies SET crux_id = ? WHERE id = ?', [
          randomUUID(),
          candidateId,
        ]);
        repair = async () => {
          await owner.run(
            'UPDATE working_copies SET crux_id = ? WHERE id = ?',
            [id, candidateId],
          );
        };
      } else if (failure === 'changed conversation') {
        await owner.run('UPDATE cruxes SET meta = ? WHERE id = ?', [
          JSON.stringify({
            ...JSON.parse(before.main.meta),
            messages: [{ role: 'user', content: 'Keep this unexpected edit' }],
          }),
          id,
        ]);
        repair = async () => {
          await owner.run('UPDATE cruxes SET meta = ? WHERE id = ?', [
            before.main.meta,
            id,
          ]);
        };
      } else if (failure === 'foreign ancestry') {
        const foreign = await owner.createCrux({
          slug: randomUUID(),
          authorId: task.snapshot.authorId,
          homeId: task.snapshot.homeId,
          kind: 'snapshot',
          meta: { contentOwnerId: id },
        });
        await owner.run(
          'INSERT INTO file_content_heads (crux_id,format_version,root,revision) SELECT ?,format_version,root,revision FROM file_content_heads WHERE crux_id = ?',
          [foreign, base.snapshot.id],
        );
        await owner.run(
          'INSERT INTO dimensions (id,source_id,target_id,type,weight,home_id,author_id,created,updated) VALUES (?,?,?, ?,0,?,?,?,?)',
          [
            randomUUID(),
            id,
            foreign,
            'growth',
            task.snapshot.homeId,
            task.snapshot.authorId,
            new Date().toISOString(),
            new Date().toISOString(),
          ],
        );
        const meta = (
          await owner.get<any>('SELECT meta FROM cruxes WHERE id = ?', [
            task.snapshot.id,
          ])
        ).meta;
        await owner.run('UPDATE cruxes SET meta = ? WHERE id = ?', [
          JSON.stringify({ ...JSON.parse(meta), parentCruxId: foreign }),
          task.snapshot.id,
        ]);
        repair = async () => {
          await owner.run('UPDATE cruxes SET meta = ? WHERE id = ?', [
            meta,
            task.snapshot.id,
          ]);
          await owner.run('DELETE FROM dimensions WHERE target_id = ?', [
            foreign,
          ]);
          await owner.run('DELETE FROM file_content_heads WHERE crux_id = ?', [
            foreign,
          ]);
          await owner.run('DELETE FROM cruxes WHERE id = ?', [foreign]);
        };
      } else if (failure === 'unlinked transcript') {
        await owner.run(
          "UPDATE dimensions SET deleted = ? WHERE source_id = ? AND target_id = ? AND type = 'growth'",
          [new Date().toISOString(), copyId, task.snapshot.id],
        );
        repair = async () => {
          await owner.run(
            'UPDATE dimensions SET deleted = NULL WHERE source_id = ? AND target_id = ?',
            [copyId, task.snapshot.id],
          );
        };
      } else if (failure === 'deleted transcript') {
        await owner.run('UPDATE cruxes SET deleted = ? WHERE id = ?', [
          new Date().toISOString(),
          task.snapshot.id,
        ]);
        repair = async () => {
          await owner.run('UPDATE cruxes SET deleted = NULL WHERE id = ?', [
            task.snapshot.id,
          ]);
        };
      } else if (failure === 'missing transcript source') {
        await owner.run('UPDATE task_merges SET data = ? WHERE id = ?', [
          JSON.stringify({
            ...JSON.parse(before.journal.data),
            sourceState: undefined,
          }),
          mergeId,
        ]);
        repair = async () => {
          await owner.run('UPDATE task_merges SET data = ? WHERE id = ?', [
            before.journal.data,
            mergeId,
          ]);
        };
      } else if (failure === 'corrupt result') {
        const bytes = objects.get(taskFile.put.fingerprint)!;
        objects.delete(taskFile.put.fingerprint);
        repair = async () => {
          objects.set(taskFile.put.fingerprint, bytes);
        };
      }
      if (failure !== 'none' && failure !== 'unmarked Task') {
        const refused = await state();
        await expect(owner.completeTaskMerge(mergeId, store)).rejects.toThrow();
        expect(await state()).toEqual(refused);
        await repair();
        expect(await state()).toEqual(before);
      }
      await owner.close();
      owner = await LocalGraphRuntime.open(join(dir, 'garden.db'));
      await owner.completeTaskMerge(mergeId, store);
      const completed = await state();
      const journal = JSON.parse(completed.journal.data);
      expect(journal.resultState).toMatchObject({
        root: mergedHead.root,
        workspace: { parentId: base.snapshot.id },
      });
      expect(
        journal.resultState.workspace.messages.filter(
          (m: any) => m.taskMergeId === mergeId,
        ),
      ).toHaveLength(1);
      if (failure === 'unmarked Task')
        expect(journal.resultState.workspace.messages.at(-1).content).toContain(
          'Unmarked Task conversation',
        );
      expect(journal).not.toHaveProperty('resultHead');
      expect(
        await owner.all("SELECT * FROM dimensions WHERE type = 'growth'"),
      ).toEqual(growthBefore);
      await owner.completeTaskMerge(mergeId, store);
      await owner.releaseTaskReview(mergeId);
      expect(await state()).toEqual(completed);
      // Later Main work must not mutate or be overwritten by a lost-response retry.
      const after = await owner.editFileContent(
        { cruxId: id, expected: mergedHead, changes: [put('Later Main')] },
        store,
      );
      await owner.completeTaskMerge(mergeId, store);
      expect(await owner.fileContentHead(id)).toEqual(after);
      expect((await state()).journal).toEqual(completed.journal);
      // Evict the ordinary recovery ring; the journal alone still retains the result tree.
      await owner.run('DELETE FROM edit_history WHERE crux_id = ?', [id]);
      expect(
        await owner.all(
          'SELECT crux_id FROM file_content_heads WHERE root = ?',
          [mergedHead.root],
        ),
      ).toEqual([]);
      const graph = await owner.exportPrivateGraph(
        { roots: [id], includeMembers: false },
        store,
      );
      expect(
        graph.taskMerges.find((m: any) => m.id === mergeId)?.data.resultState,
      ).toEqual(journal.resultState);
      expect(graph.fingerprints).toContain(mergedHead.root);
      const destinationObjects = new Map<string, Uint8Array>();
      const destinationStore = {
        read: async (fp: string) => destinationObjects.get(fp) ?? null,
        write: async (fp: string, bytes: Uint8Array) => {
          destinationObjects.set(fp, Uint8Array.from(bytes));
        },
      };
      const destination = await LocalGraphRuntime.create(
        join(dir, 'destination.db'),
      );
      try {
        const cloned = await destination.importPrivateGraph(
          {
            requestId: randomUUID(),
            mode: 'copy',
            destination: { authorId: randomUUID(), homeId: randomUUID() },
            graph,
          },
          store,
          destinationStore,
        );
        const roundtrip = await destination.exportPrivateGraph(
          { roots: cloned.roots, includeMembers: false },
          destinationStore,
        );
        const copiedResult = roundtrip.taskMerges.find(
          (row: any) => row.id === cloned.ids[mergeId],
        )!.data.resultState as any;
        expect(copiedResult.root).toBe(mergedHead.root);
        expect(copiedResult.workspace.parentId).toBe(
          cloned.ids[base.snapshot.id],
        );
        expect(
          copiedResult.workspace.messages.find((m: any) => m.taskMergeId)
            ?.taskMergeId,
        ).toBe(cloned.ids[mergeId]);
      } finally {
        await destination.close();
      }
      const backup = await owner.exportDatabase();
      const recovered = await inspectDesktopManifestRecovery(backup, store);
      expect(recovered.fingerprints).toContain(mergedHead.root);
      expect(
        (
          await owner.get<any>(
            'SELECT phase FROM working_copies WHERE id = ?',
            [copyId],
          )
        ).phase,
      ).toBe('merged');
      expect(await owner.fileContentHead(base.snapshot.id)).toEqual(base.head);
      expect(await owner.all('SELECT * FROM artifacts')).toEqual([]);
    },
  );

  it.each(['stale metadata', 'refused projection intent'])(
    'keeps both content and conversation when restore meets %s',
    async (failure) => {
      const base = await owner.createGrowthSnapshot(request(), store);
      head = await owner.editFileContent(
        { cruxId: id, expected: head, changes: [put('Current')] },
        store,
      );
      await owner.updateCrux(id, {
        meta: { projectFolder: '/owned/current', messages: ['Current'] },
      });
      const before = await owner.execute(({ crux }) => crux.findById(id));
      if (failure === 'refused projection intent')
        await owner.run(`CREATE TRIGGER refuse_projection
        BEFORE INSERT ON settings WHEN NEW.key LIKE 'cruxgarden:content-projection:%'
        BEGIN SELECT RAISE(IGNORE); END`);
      await expect(
        owner.restoreGrowthContent(
          {
            safety: selection(),
            target: { cruxId: base.snapshot.id, expected: base.head },
            workspace: {
              expectedMeta: failure === 'stale metadata' ? {} : before.meta,
              messages: [],
            },
          },
          store,
        ),
      ).rejects.toThrow();
      expect(await owner.fileContentHead(id)).toEqual(head);
      expect(await owner.execute(({ crux }) => crux.findById(id))).toEqual(
        before,
      );
      expect(
        await owner.all("SELECT id FROM cruxes WHERE kind = 'snapshot'"),
      ).toHaveLength(1);
      expect(
        await owner.all(
          "SELECT key FROM settings WHERE key LIKE 'cruxgarden:content-projection:%'",
        ),
      ).toEqual([]);
    },
  );

  it('refuses to project into a replaced folder and keeps an unacknowledged projection retryable', async () => {
    const base = await owner.createGrowthSnapshot(request(), store);
    head = await owner.editFileContent(
      { cruxId: id, expected: head, changes: [put('Current')] },
      store,
    );
    await owner.updateCrux(id, { meta: { projectFolder: '/owned/original' } });
    const before = await owner.execute(({ crux }) => crux.findById(id));
    await owner.restoreGrowthContent(
      {
        safety: selection(),
        target: { cruxId: base.snapshot.id, expected: base.head },
        workspace: { expectedMeta: before.meta, messages: [] },
      },
      store,
    );
    await owner.run(
      "UPDATE cruxes SET meta = json_set(meta, '$.projectFolder', ?) WHERE id = ?",
      ['/owned/replacement', id],
    );
    const apply = jest.fn(async () => {});
    await expect(
      owner.finishContentProjection(id, store, apply),
    ).rejects.toThrow('Folder');
    expect(apply).not.toHaveBeenCalled();
    await owner.run(
      "UPDATE cruxes SET meta = json_set(meta, '$.projectFolder', ?) WHERE id = ?",
      ['/owned/original', id],
    );
    await owner.run(`CREATE TRIGGER refuse_projection_clear BEFORE DELETE ON settings
      WHEN OLD.key LIKE 'cruxgarden:content-projection:%' BEGIN SELECT RAISE(IGNORE); END`);
    await expect(
      owner.finishContentProjection(id, store, apply),
    ).rejects.toThrow('persist');
    expect(apply).toHaveBeenCalledTimes(1);
    await owner.close();
    owner = await LocalGraphRuntime.open(join(dir, 'garden.db'));
    await owner.run('DROP TRIGGER refuse_projection_clear');
    expect(await owner.finishContentProjection(id, store, apply)).toBe(true);
    expect(apply).toHaveBeenCalledTimes(2);
    expect(await owner.finishContentProjection(id, store, apply)).toBe(false);
  });

  it('atomically connects a snapshot Crux and retains its root without copying content or file records', async () => {
    const input = request();
    const write = jest.spyOn(store, 'write');
    const notices: LocalGraphChange[] = [];
    owner.onChange((change) => {
      notices.push(change);
    });
    const saved = await owner.createGrowthSnapshot(input, store);
    expect(saved.head).toEqual({
      ...head,
      cruxId: input.snapshotId,
      revision: 1,
    });
    expect(saved.growth).toMatchObject({
      sourceId: id,
      targetId: input.snapshotId,
      type: 'growth',
      weight: 1,
      meta: input.dimensionMeta,
    });
    expect(saved.snapshot).toMatchObject({
      id: input.snapshotId,
      kind: 'snapshot',
      title: input.title,
      visibility: 'private',
      meta: { ...input.meta, contentOwnerId: id, parentCruxId: null },
    });
    expect(write).not.toHaveBeenCalled();
    expect(await owner.all('SELECT * FROM artifacts')).toEqual([]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      entity: 'crux',
      id,
      fields: ['growth'],
    });
    const next = await owner.editFileContent(
      { cruxId: id, expected: head, changes: [put('Second version')] },
      store,
    );
    expect(next.root).not.toBe(head.root);
    await owner.close();
    owner = await LocalGraphRuntime.open(join(dir, 'garden.db'));
    const original = await owner.readFileContent(
      { cruxId: input.snapshotId, expected: saved.head, path: 'hello.txt' },
      store,
    );
    expect(Buffer.from(original!.bytes).toString()).toBe('First\0version');
    await expect(
      owner.editFileContent(
        {
          cruxId: input.snapshotId,
          expected: saved.head,
          changes: [put('overwrite')],
        },
        store,
      ),
    ).rejects.toThrow('live editable Crux');
    const image = await owner.exportDatabase();
    const recovery = await inspectDesktopManifestRecovery(image, store);
    expect(recovery).toBeDefined();
    objects.delete(put('First\0version').put.fingerprint);
    await expect(
      inspectDesktopManifestRecovery(image, store),
    ).rejects.toThrow();
  });

  it('protects recovery conversation ancestry from version deletion, but purges owned retention with its Crux', async () => {
    const base = await owner.createGrowthSnapshot(request(), store);
    const later = await owner.createGrowthSnapshot(
      { ...request(), parentId: base.snapshot.id },
      store,
    );
    await owner.updateCrux(id, {
      meta: {
        messages: [{ role: 'user', content: 'Still unmarked' }],
        settings: { activeBranch: later.snapshot.id },
      },
    });
    const current = await owner.get<any>(
      'SELECT meta FROM cruxes WHERE id = ?',
      [id],
    );
    const restored = await owner.restoreGrowthContent(
      {
        safety: selection(),
        target: { cruxId: base.snapshot.id, expected: base.head },
        workspace: { expectedMeta: JSON.parse(current.meta), messages: [] },
      },
      store,
    );
    expect(restored.safety.workspace?.parentId).toBe(later.snapshot.id);
    for (const target of [later.snapshot.id, base.snapshot.id])
      await expect(owner.deleteCrux(target)).rejects.toThrow(
        /recovery|referenced|used/,
      );
    await expect(owner.setCruxTrashed(later.snapshot.id, true)).rejects.toThrow(
      'recovery copy',
    );
    await owner.close();
    owner = await LocalGraphRuntime.open(join(dir, 'garden.db'));
    await expect(owner.deleteCrux(later.snapshot.id)).rejects.toThrow(
      /recovery|referenced|used/,
    );
    expect(
      (
        await owner.exportPrivateGraph(
          { roots: [id], includeMembers: false },
          store,
        )
      ).cruxes,
    ).toHaveLength(3);
    // Explicitly purging the entire owner also removes its own retention records.
    await owner.deleteCrux(id);
    expect(await owner.all('SELECT * FROM file_content_heads')).toEqual([]);
    expect(await owner.all('SELECT * FROM edit_history')).toEqual([]);
    expect(await owner.all('SELECT id FROM cruxes')).toEqual([]);
    await expect(
      inspectDesktopManifestRecovery(await owner.exportDatabase(), store),
    ).resolves.toBeDefined();
  });

  it.each(['file_content_heads', 'edit_history', 'settings'])(
    'refuses an ignored %s purge and retains all current and recovery data',
    async (table) => {
      await owner.createEditCheckpoint(
        { ...selection(), reason: 'safety' },
        store,
      );
      await owner.run('INSERT INTO settings (key, value) VALUES (?, ?)', [
        `cruxgarden:content-projection:${id}`,
        JSON.stringify({ head, folder: '/isolated-unused' }),
      ]);
      await owner.run(
        `CREATE TRIGGER hold_retention BEFORE DELETE ON ${table} BEGIN SELECT RAISE(IGNORE); END`,
      );
      await expect(owner.deleteCrux(id)).rejects.toThrow(
        'Incomplete Crux deletion',
      );
      expect(
        await owner.get('SELECT id FROM cruxes WHERE id = ?', [id]),
      ).toEqual({ id });
      expect(await owner.fileContentHead(id)).toEqual(head);
      expect((await owner.listEditHistory(id)).checkpoints).toHaveLength(1);
      await owner.run('DROP TRIGGER hold_retention');
      await owner.deleteCrux(id);
      expect(await owner.all('SELECT * FROM file_content_heads')).toEqual([]);
      expect(await owner.all('SELECT * FROM edit_history')).toEqual([]);
      expect(
        await owner.get('SELECT key FROM settings WHERE key = ?', [
          `cruxgarden:content-projection:${id}`,
        ]),
      ).toBeUndefined();
    },
  );

  it('retains conversation-only safety changes outside Growth and keeps them through private graph copy', async () => {
    const version = await owner.createGrowthSnapshot(request(), store);
    const messages = [{ role: 'user', content: 'Unmarked rough mix' }];
    await owner.updateCrux(id, {
      meta: {
        messages,
        settings: { activeBranch: version.snapshot.id, entryFile: 'hello.txt' },
      },
    });
    const first = await owner.restoreGrowthContent(
      {
        safety: selection(),
        target: { cruxId: version.snapshot.id, expected: version.head },
      },
      store,
    );
    expect(first.safety).toMatchObject({
      root: head.root,
      reason: 'safety',
      workspace: {
        parentId: version.snapshot.id,
        messages,
        entryFile: 'hello.txt',
      },
    });
    head = first.head;
    await owner.updateCrux(id, {
      meta: {
        messages: [{ role: 'user', content: 'Another thought, same files' }],
        settings: { activeBranch: version.snapshot.id, entryFile: 'hello.txt' },
      },
    });
    const second = await owner.restoreGrowthContent(
      {
        safety: selection(),
        target: { cruxId: version.snapshot.id, expected: version.head },
      },
      store,
    );
    expect(second.safety).not.toEqual(first.safety);
    expect(
      await owner.all("SELECT id FROM dimensions WHERE type='growth'"),
    ).toHaveLength(1);
    expect(
      await owner.all("SELECT id FROM cruxes WHERE kind='snapshot'"),
    ).toHaveLength(1);
    head = second.head;
    for (let index = 0; index < 25; index++) {
      head = await owner.editFileContent(
        { cruxId: id, expected: head, changes: [put(`Later edit ${index}`)] },
        store,
      );
      await owner.createEditCheckpoint(selection(), store);
    }
    const graph = await owner.exportPrivateGraph(
      { roots: [id], includeMembers: false },
      store,
    );
    expect(
      graph.editHistory?.[0].checkpoints.filter((p) => p.reason === 'safety'),
    ).toHaveLength(2);
    const destination = await LocalGraphRuntime.create(
      join(dir, 'context-copy.db'),
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
      const retained = await destination.listEditHistory(copied.roots[0]);
      const safety = retained.checkpoints.filter((p) => p.reason === 'safety');
      expect(safety.map((p) => p.workspace?.parentId)).toEqual([
        copied.ids[version.snapshot.id],
        copied.ids[version.snapshot.id],
      ]);
      expect(safety[0].workspace?.messages).toEqual(messages);
      expect(safety[0].id).not.toBe(first.safety.id);
      const invalid = structuredClone(graph);
      invalid.editHistory![0].checkpoints.find(
        (p) => p.reason === 'safety',
      )!.workspace!.parentId = randomUUID();
      await expect(
        destination.importPrivateGraph(
          {
            requestId: randomUUID(),
            mode: 'copy',
            destination: { authorId: randomUUID(), homeId: randomUUID() },
            graph: invalid,
          },
          store,
          store,
        ),
      ).rejects.toThrow('recovery');
      expect(
        await destination.all("SELECT id FROM cruxes WHERE kind='snapshot'"),
      ).toHaveLength(1);
    } finally {
      await destination.close();
    }
  });

  it('explicitly recovers unmarked files and conversation context while default recovery keeps current conversation', async () => {
    const version = await owner.createGrowthSnapshot(request(), store);
    head = await owner.editFileContent(
      { cruxId: id, expected: head, changes: [put('Unmarked work')] },
      store,
    );
    await owner.updateCrux(id, {
      meta: {
        messages: [{ role: 'user', content: 'Unmarked conversation' }],
        settings: { activeBranch: version.snapshot.id, entryFile: 'rough.txt' },
      },
    });
    const before = await owner.execute(({ crux }) => crux.findById(id));
    const restored = await owner.restoreGrowthContent(
      {
        safety: selection(),
        target: { cruxId: version.snapshot.id, expected: version.head },
        workspace: { expectedMeta: before.meta, messages: [] },
      },
      store,
    );
    const current = await owner.execute(({ crux }) => crux.findById(id));
    expect(current.meta.messages).toEqual([]);
    const failedHistory = await owner.listEditHistory(id);
    await expect(
      owner.restoreEditCheckpoint(
        {
          cruxId: id,
          expected: restored.head,
          checkpointId: restored.safety.id,
          workspace: { expectedMeta: { stale: true } },
        },
        store,
      ),
    ).rejects.toThrow('changed');
    expect(await owner.fileContentHead(id)).toEqual(restored.head);
    expect(await owner.listEditHistory(id)).toEqual(failedHistory);
    const filesOnly = await owner.restoreEditCheckpoint(
      { cruxId: id, expected: restored.head, checkpointId: restored.safety.id },
      store,
    );
    expect(
      (await owner.execute(({ crux }) => crux.findById(id))).meta.messages,
    ).toEqual([]);
    const recovered = await owner.restoreEditCheckpoint(
      {
        cruxId: id,
        expected: filesOnly.head,
        checkpointId: restored.safety.id,
        workspace: { expectedMeta: current.meta },
      },
      store,
    );
    expect(recovered.head.root).toBe(head.root);
    const final = await owner.execute(({ crux }) => crux.findById(id));
    expect(final.meta.messages).toEqual(before.meta.messages);
    expect(final.meta.settings).toEqual(before.meta.settings);
    expect(
      await owner.all("SELECT id FROM dimensions WHERE type='growth'"),
    ).toHaveLength(1);
    await owner.close();
    owner = await LocalGraphRuntime.open(join(dir, 'garden.db'));
    expect(
      (await owner.execute(({ crux }) => crux.findById(id))).meta.messages,
    ).toEqual(before.meta.messages);
    expect(
      (await owner.listEditHistory(id)).checkpoints.find(
        (p) => p.id === restored.safety.id,
      ),
    ).toEqual(restored.safety);
  });

  it('restores retained content and captures the previous root in the same transaction, without copying bytes', async () => {
    const target = await owner.createGrowthSnapshot(request(), store);
    head = await owner.editFileContent(
      { cruxId: id, expected: head, changes: [put('Current work')] },
      store,
    );
    const currentHead = head;
    const safety = selection();
    const notices: LocalGraphChange[] = [];
    owner.onChange((change) => {
      notices.push(change);
    });
    const write = jest.spyOn(store, 'write');
    const result = await owner.restoreGrowthContent(
      {
        safety,
        target: { cruxId: target.snapshot.id, expected: target.head },
      },
      store,
    );
    expect(result.head).toEqual({
      ...head,
      root: target.head.root,
      revision: head.revision + 1,
    });
    expect(result.safety).toMatchObject({
      root: currentHead.root,
      reason: 'safety',
      workspace: {
        messages: [],
        parentId: target.snapshot.id,
        entryFile: null,
      },
    });
    expect(
      await owner.all("SELECT id FROM dimensions WHERE type='growth'"),
    ).toHaveLength(1);
    expect(write).not.toHaveBeenCalled();
    expect(await owner.all('SELECT * FROM artifacts')).toEqual([]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      id,
      fields: ['editHistory', 'fileContent'],
    });
    await owner.close();
    owner = await LocalGraphRuntime.open(join(dir, 'garden.db'));
    const read = async (cruxId: string, expected: FileContentHead) =>
      Buffer.from(
        (await owner.readFileContent(
          { cruxId, expected, path: 'hello.txt' },
          store,
        ))!.bytes,
      ).toString();
    expect(await read(id, result.head)).toBe('First\0version');
    expect(
      (await owner.inspectEditCheckpoint(id, result.safety.id, store)).files[0]
        .fingerprint,
    ).toBe(put('Current work').put.fingerprint);
    expect(await read(target.snapshot.id, target.head)).toBe('First\0version');
  });

  it.each([
    [
      'safety copy',
      "BEFORE UPDATE ON edit_history BEGIN SELECT RAISE(ABORT, 'Safety refused'); END",
    ],
    [
      'ignored safety copy',
      'BEFORE UPDATE ON edit_history BEGIN SELECT RAISE(IGNORE); END',
    ],
    [
      'live root',
      'BEFORE UPDATE ON file_content_heads BEGIN SELECT RAISE(IGNORE); END',
    ],
    [
      'late safety alteration',
      "AFTER UPDATE ON file_content_heads BEGIN UPDATE edit_history SET checkpoints = '[]'; END",
    ],
    [
      'late retained head alteration',
      'AFTER UPDATE ON file_content_heads BEGIN UPDATE file_content_heads SET revision = 9 WHERE crux_id <> NEW.crux_id; END',
    ],
  ])(
    'rolls back restoration when %s fails, including its safety snapshot, and can retry after restart',
    async (_name, trigger) => {
      const target = await owner.createGrowthSnapshot(request(), store);
      head = await owner.editFileContent(
        { cruxId: id, expected: head, changes: [put('Current work')] },
        store,
      );
      const input = {
        safety: selection(),
        target: { cruxId: target.snapshot.id, expected: target.head },
      };
      const notices = jest.fn();
      owner.onChange(notices);
      await owner.run(`CREATE TRIGGER refuse_restore ${trigger}`);
      await expect(owner.restoreGrowthContent(input, store)).rejects.toThrow();
      expect(await owner.fileContentHead(id)).toEqual(head);
      expect(await owner.fileContentHead(target.snapshot.id)).toEqual(
        target.head,
      );
      expect(
        await owner.all("SELECT id FROM cruxes WHERE kind='snapshot'"),
      ).toHaveLength(1);
      expect(await owner.all('SELECT * FROM dimensions')).toHaveLength(1);
      expect(notices).not.toHaveBeenCalled();
      await owner.close();
      owner = await LocalGraphRuntime.open(join(dir, 'garden.db'));
      expect(await owner.fileContentHead(id)).toEqual(head);
      await owner.run('DROP TRIGGER refuse_restore');
      const result = await owner.restoreGrowthContent(input, store);
      expect(result.head.root).toBe(target.head.root);
      expect(result.safety.root).toBe(head.root);
    },
  );

  it('refuses stale or foreign selections before content reads and missing bytes before any graph changes', async () => {
    const target = await owner.createGrowthSnapshot(request(), store);
    head = await owner.editFileContent(
      { cruxId: id, expected: head, changes: [put('Current work')] },
      store,
    );
    const input = {
      safety: selection(),
      target: { cruxId: target.snapshot.id, expected: target.head },
    };
    const read = jest.spyOn(store, 'read');
    await expect(
      owner.restoreGrowthContent(
        {
          ...input,
          safety: {
            ...input.safety,
            expected: { ...head, revision: head.revision + 1 },
          },
        },
        store,
      ),
    ).rejects.toThrow('changed');
    await expect(
      owner.restoreGrowthContent(
        {
          ...input,
          target: {
            ...input.target,
            expected: { ...target.head, root: '0'.repeat(64) },
          },
        },
        store,
      ),
    ).rejects.toThrow('selected retained snapshot');
    await expect(
      owner.restoreGrowthContent(
        {
          ...input,
          target: { cruxId: id, expected: head },
        },
        store,
      ),
    ).rejects.toThrow('selected retained snapshot');
    const other = await owner.createCrux({
      slug: randomUUID(),
      authorId: randomUUID(),
      homeId: randomUUID(),
    });
    const otherHead = await owner.editFileContent(
      { cruxId: other, expected: null, changes: [] },
      store,
    );
    const foreign = await owner.createGrowthSnapshot(
      { ...request(), cruxId: other, expected: otherHead },
      store,
    );
    read.mockClear();
    await expect(
      owner.restoreGrowthContent(
        {
          ...input,
          target: { cruxId: foreign.snapshot.id, expected: foreign.head },
        },
        store,
      ),
    ).rejects.toThrow('selected retained snapshot');
    expect(read).not.toHaveBeenCalled();
    for (const text of ['First\0version', 'Current work']) {
      const fp = put(text).put.fingerprint;
      const bytes = objects.get(fp)!;
      objects.delete(fp);
      await expect(owner.restoreGrowthContent(input, store)).rejects.toThrow();
      expect(await owner.fileContentHead(id)).toEqual(head);
      expect(
        await owner.all("SELECT id FROM cruxes WHERE kind='snapshot'"),
      ).toHaveLength(2);
      objects.set(fp, bytes);
    }
    await expect(
      owner.restoreGrowthContent(input, store),
    ).resolves.toMatchObject({ head: { root: target.head.root } });
  });

  it('captures queued restore selections, workspace expectations and storage reader', async () => {
    const target = await owner.createGrowthSnapshot(request(), store);
    head = await owner.editFileContent(
      { cruxId: id, expected: head, changes: [put('Current work')] },
      store,
    );
    await owner.updateCrux(id, {
      meta: { messages: ['Unmarked before queue'] },
    });
    const current = await owner.execute(({ crux }) => crux.findById(id));
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocker = owner.execute(async () => {
      await wait;
    });
    const input = {
      safety: selection(),
      workspace: { expectedMeta: current.meta, messages: [] as unknown[] },
      target: { cruxId: target.snapshot.id, expected: { ...target.head } },
    };
    const original = structuredClone(input);
    const pending = owner.restoreGrowthContent(input, store);
    input.target.cruxId = id;
    input.target.expected.root = '0'.repeat(64);
    input.safety.expected.revision = 100;
    input.workspace.expectedMeta.messages[0] = 'Changed after submission';
    input.workspace.messages.push('Changed after submission');
    store.read = async () => {
      throw new Error('Reader replaced');
    };
    release();
    await blocker;
    const result = await pending;
    expect(result.head.root).toBe(target.head.root);
    expect(result.safety.workspace?.messages).toEqual(
      original.workspace.expectedMeta.messages,
    );
    expect(
      (await owner.execute(({ crux }) => crux.findById(id))).meta.messages,
    ).toEqual([]);
    expect(result.head.root).toBe(original.target.expected.root);
  });

  it('keeps explicit branches under the same owner and rejects a foreign parent', async () => {
    const a = await owner.createGrowthSnapshot(request(), store);
    const b = await owner.createGrowthSnapshot(
      { ...request(), parentId: a.snapshot.id },
      store,
    );
    const c = await owner.createGrowthSnapshot(
      { ...request(), parentId: a.snapshot.id },
      store,
    );
    expect(b.snapshot.meta.parentCruxId).toBe(a.snapshot.id);
    expect(c.snapshot.meta.parentCruxId).toBe(a.snapshot.id);
    expect([a.growth.weight, b.growth.weight, c.growth.weight]).toEqual([
      1, 2, 3,
    ]);
    const other = await owner.createCrux({
      slug: randomUUID(),
      authorId: randomUUID(),
      homeId: randomUUID(),
    });
    const otherHead = await owner.editFileContent(
      { cruxId: other, expected: null, changes: [] },
      store,
    );
    await expect(
      owner.createGrowthSnapshot(
        {
          ...request(),
          cruxId: other,
          expected: otherHead,
          parentId: a.snapshot.id,
        },
        store,
      ),
    ).rejects.toThrow('parent');
    await expect(
      owner.createGrowthSnapshot({ ...request(), parentId: id }, store),
    ).rejects.toThrow('parent');
  });

  it.each([
    [
      'snapshot',
      "BEFORE INSERT ON cruxes WHEN NEW.kind = 'snapshot' BEGIN SELECT RAISE(IGNORE); END",
    ],
    [
      'head',
      "BEFORE INSERT ON file_content_heads BEGIN SELECT RAISE(ABORT, 'Head refused'); END",
    ],
    [
      'dimension',
      'BEFORE INSERT ON dimensions BEGIN SELECT RAISE(IGNORE); END',
    ],
    [
      'altered dimension',
      'AFTER INSERT ON dimensions BEGIN UPDATE dimensions SET target_id = source_id WHERE id = NEW.id; END',
    ],
    [
      'altered snapshot',
      "AFTER INSERT ON cruxes WHEN NEW.kind = 'snapshot' BEGIN UPDATE cruxes SET meta = '{}' WHERE id = NEW.id; END",
    ],
    [
      'late head alteration',
      'AFTER INSERT ON dimensions BEGIN UPDATE file_content_heads SET revision = 8 WHERE crux_id = NEW.target_id; END',
    ],
    [
      'late metadata alteration',
      "AFTER INSERT ON dimensions BEGIN UPDATE cruxes SET meta = '{}' WHERE id = NEW.target_id; END",
    ],
  ])(
    'rolls back a refused %s, survives restart and permits retry',
    async (_name, trigger) => {
      const input = request();
      const notices = jest.fn();
      owner.onChange(notices);
      await owner.run(`CREATE TRIGGER refuse_growth ${trigger}`);
      await expect(owner.createGrowthSnapshot(input, store)).rejects.toThrow();
      expect(
        await owner.get('SELECT id FROM cruxes WHERE id = ?', [
          input.snapshotId,
        ]),
      ).toBeUndefined();
      expect(await owner.all('SELECT * FROM dimensions')).toEqual([]);
      expect(await owner.fileContentHead(id)).toEqual(head);
      expect(notices).not.toHaveBeenCalled();
      await owner.close();
      owner = await LocalGraphRuntime.open(join(dir, 'garden.db'));
      await owner.run('DROP TRIGGER refuse_growth');
      await owner.createGrowthSnapshot(input, store);
      await expect(owner.createGrowthSnapshot(input, store)).rejects.toThrow(
        'already exists',
      );
      expect(await owner.all('SELECT * FROM dimensions')).toHaveLength(1);
    },
  );

  it('refuses stale content before reading blobs and corrupt retained bytes without creating a snapshot', async () => {
    const input = request();
    const read = jest.spyOn(store, 'read');
    await expect(
      owner.createGrowthSnapshot(
        { ...input, expected: { ...head, revision: 9 } },
        store,
      ),
    ).rejects.toThrow('changed');
    expect(read).not.toHaveBeenCalled();
    objects.set(put('First\0version').put.fingerprint, Buffer.from('corrupt'));
    await expect(owner.createGrowthSnapshot(input, store)).rejects.toThrow();
    expect(
      await owner.all("SELECT * FROM cruxes WHERE kind = 'snapshot'"),
    ).toEqual([]);
    expect(await owner.all('SELECT * FROM dimensions')).toEqual([]);
  });

  it('captures queued metadata and storage reader, and rejects lossy metadata or reserved ownership', async () => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocker = owner.execute(async () => {
      await wait;
    });
    const input = request();
    const original = structuredClone(input);
    const pending = owner.createGrowthSnapshot(input, store);
    input.meta.messages[0].content = 'mutated';
    input.expected.root = '0'.repeat(64);
    store.read = async () => {
      throw new Error('reader replaced');
    };
    release();
    await blocker;
    const result = await pending;
    expect(result.snapshot.meta.messages).toEqual(original.meta.messages);
    for (const meta of [
      { value: NaN },
      { value: undefined },
      { contentOwnerId: 'foreign' },
      { parentCruxId: null },
    ]) {
      await expect(
        owner.createGrowthSnapshot({ ...request(), meta }, store),
      ).rejects.toThrow();
    }
  });
});
