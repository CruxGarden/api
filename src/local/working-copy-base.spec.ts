import { createHash, randomUUID } from 'crypto';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { LocalGraphRuntime } from './graph-runtime';
import { DesktopContentStore } from './desktop-content';
import { inspectDesktopManifestRecovery } from './desktop-recovery';
import { LocalWorkingCopyCreate } from './working-copy-create';

describe('retained Task starting state', () => {
  let owner: LocalGraphRuntime;
  let dir: string;
  let objects: Map<string, Uint8Array>;
  let store: DesktopContentStore;
  let main: string;
  let input: LocalWorkingCopyCreate;
  const put = (text: string) => {
    const bytes = Buffer.from(text);
    return {
      bytes,
      put: {
        id: 'file',
        path: 'work.txt',
        fingerprint: createHash('sha256').update(bytes).digest('hex'),
        size: bytes.length,
        mode: 0o644,
        mimeType: 'text/plain',
        encoding: 'utf-8' as const,
        attributes: {},
      },
    };
  };
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'task-base-'));
    objects = new Map();
    store = {
      read: async (key) => objects.get(key) ?? null,
      write: async (key, bytes) => {
        objects.set(key, Uint8Array.from(bytes));
      },
    };
    owner = await LocalGraphRuntime.create(join(dir, 'garden.db'));
    const meta = {
      messages: [{ role: 'user', content: 'Unmarked Main context' }],
      settings: { entryFile: null },
    };
    main = await owner.createCrux({
      slug: randomUUID(),
      authorId: randomUUID(),
      homeId: randomUUID(),
      meta,
    });
    const head = await owner.editFileContent(
      { cruxId: main, expected: null, changes: [put('Starting work')] },
      store,
    );
    input = {
      id: randomUUID(),
      cruxId: main,
      taskId: randomUUID(),
      title: 'Task',
      role: 'task',
      base: { expected: head, expectedMeta: meta },
      meta: { messages: [{ role: 'user', content: 'Task instruction' }] },
    };
  });
  afterEach(async () => {
    await owner.close();
    rmSync(dir, { recursive: true, force: true });
  });
  it('starts before any marked Growth and survives restart independently without mixing conversations', async () => {
    await owner.createWorkingCopy(input, store);
    const original = await owner.workingCopyBase(input.id, store);
    expect(original).toMatchObject({
      root: input.base.expected!.root,
      workspace: {
        parentId: null,
        messages: input.base.expectedMeta.messages,
        entryFile: null,
      },
    });
    expect(original.entries).toHaveLength(1);
    expect(
      await owner.all("SELECT id FROM dimensions WHERE type = 'growth'"),
    ).toEqual([]);
    expect(await owner.fileContentHead(input.id)).toMatchObject({
      root: original.root,
      revision: 1,
    });
    const row = await owner.get<any>(
      'SELECT meta, base_state FROM working_copies WHERE id = ?',
      [input.id],
    );
    expect(JSON.parse(row.meta).messages).toEqual(input.meta.messages);
    expect(JSON.parse(row.base_state).workspace.messages).toEqual(
      input.base.expectedMeta.messages,
    );
    await owner.updateCrux(main, {
      meta: { messages: [{ role: 'user', content: 'Later Main' }] },
    });
    await owner.close();
    owner = await LocalGraphRuntime.open(join(dir, 'garden.db'));
    expect(await owner.workingCopyBase(input.id, store)).toEqual(original);
  });
  it('retains the actual Task source rather than Main when starting delegated work', async () => {
    await owner.createWorkingCopy(input, store);
    await owner.run("UPDATE working_copies SET phase = 'ready' WHERE id = ?", [
      input.id,
    ]);
    const head = await owner.editFileContent(
      {
        cruxId: input.id,
        expected: await owner.fileContentHead(input.id),
        changes: [put('Task-specific starting work')],
      },
      store,
    );
    const sourceMeta = {
      messages: [{ role: 'user', content: 'Task-only context' }],
      settings: { activeBranch: null },
    };
    await owner.updateWorkingCopyMeta(input.id, sourceMeta);
    const child = {
      ...input,
      id: randomUUID(),
      taskId: randomUUID(),
      base: { sourceId: input.id, expected: head, expectedMeta: sourceMeta },
    };
    await owner.createWorkingCopy(child, store);
    const retained = await owner.workingCopyBase(child.id, store);
    expect(retained).toMatchObject({
      sourceId: input.id,
      root: head.root,
      workspace: { messages: sourceMeta.messages },
    });
    expect(retained.root).not.toBe(input.base.expected!.root);
    await owner.close();
    owner = await LocalGraphRuntime.open(join(dir, 'garden.db'));
    expect(await owner.workingCopyBase(child.id, store)).toEqual(retained);
    expect(
      await owner.all("SELECT id FROM dimensions WHERE type = 'growth'"),
    ).toEqual([]);
    const graph = await owner.exportPrivateGraph(
      { roots: [main], includeMembers: false },
      store,
    );
    const target = await LocalGraphRuntime.create(
      join(dir, 'delegated-copy.db'),
    );
    try {
      const result = await target.importPrivateGraph(
        {
          requestId: randomUUID(),
          mode: 'copy',
          destination: { authorId: randomUUID(), homeId: randomUUID() },
          graph,
        },
        store,
        store,
      );
      expect(
        await target.workingCopyBase(result.ids[child.id], store),
      ).toMatchObject({
        ...retained,
        sourceId: result.ids[input.id],
      });
      expect(
        (
          await inspectDesktopManifestRecovery(
            await owner.exportDatabase(),
            store,
          )
        ).fingerprints,
      ).toContain(retained.root);
    } finally {
      await target.close();
    }
  });
  it('retains marked ancestry through source Tasks, including inherited Main anchors', async () => {
    const marked = await owner.createGrowthSnapshot(
      {
        cruxId: main,
        expected: input.base.expected!,
        snapshotId: randomUUID(),
        parentId: null,
      },
      store,
    );
    const mainMeta = {
      ...input.base.expectedMeta,
      settings: { activeBranch: marked.snapshot.id },
    };
    await owner.updateCrux(main, { meta: mainMeta });
    input.base.expectedMeta = mainMeta;
    await owner.createWorkingCopy(input, store);
    await owner.run("UPDATE working_copies SET phase = 'ready' WHERE id = ?", [
      input.id,
    ]);
    const createChild = async (sourceId: string) => {
      const source = await owner.get<any>(
        'SELECT meta FROM working_copies WHERE id = ?',
        [sourceId],
      );
      const child = {
        ...input,
        id: randomUUID(),
        taskId: randomUUID(),
        base: {
          sourceId,
          expected: await owner.fileContentHead(sourceId),
          expectedMeta: JSON.parse(source.meta),
        },
      };
      await owner.createWorkingCopy(child, store);
      await owner.run(
        "UPDATE working_copies SET phase = 'ready' WHERE id = ?",
        [child.id],
      );
      return child;
    };
    const inherited = await createChild(input.id);
    expect(
      (await owner.workingCopyBase(inherited.id, store)).workspace.parentId,
    ).toBe(marked.snapshot.id);
    const taskMark = await owner.createGrowthSnapshot(
      {
        cruxId: input.id,
        expected: await owner.fileContentHead(input.id),
        snapshotId: randomUUID(),
        parentId: marked.snapshot.id,
      },
      store,
    );
    await owner.updateWorkingCopyMeta(input.id, {
      settings: { activeBranch: taskMark.snapshot.id },
    });
    const own = await createChild(input.id);
    const descendant = await createChild(own.id);
    expect(
      (await owner.workingCopyBase(descendant.id, store)).workspace.parentId,
    ).toBe(taskMark.snapshot.id);
    await owner.createGrowthSnapshot(
      {
        cruxId: descendant.id,
        expected: await owner.fileContentHead(descendant.id),
        snapshotId: randomUUID(),
        parentId: taskMark.snapshot.id,
      },
      store,
    );
    const graph = await owner.exportPrivateGraph(
      { roots: [main], includeMembers: false },
      store,
    );
    const target = await LocalGraphRuntime.create(
      join(dir, 'marked-source.db'),
    );
    try {
      const imported = await target.importPrivateGraph(
        {
          requestId: randomUUID(),
          mode: 'copy',
          destination: { authorId: randomUUID(), homeId: randomUUID() },
          graph,
        },
        store,
        store,
      );
      expect(
        await target.workingCopyBase(imported.ids[descendant.id], store),
      ).toMatchObject({
        sourceId: imported.ids[own.id],
        workspace: { parentId: imported.ids[taskMark.snapshot.id] },
      });
    } finally {
      await target.close();
    }
  });
  it.each([
    'missing',
    'foreign',
    'closed',
    'review',
    'stale files',
    'stale context',
    'ignored write',
  ])('refuses a %s source without partial delegated work', async (fault) => {
    await owner.createWorkingCopy(input, store);
    await owner.run("UPDATE working_copies SET phase = 'ready' WHERE id = ?", [
      input.id,
    ]);
    const child = {
      ...input,
      id: randomUUID(),
      taskId: randomUUID(),
      base: {
        sourceId: input.id,
        expected: await owner.fileContentHead(input.id),
        expectedMeta: JSON.parse(
          (
            await owner.get<any>(
              'SELECT meta FROM working_copies WHERE id = ?',
              [input.id],
            )
          ).meta,
        ),
      },
    };
    if (fault === 'missing') child.base.sourceId = randomUUID();
    if (fault === 'foreign') {
      child.cruxId = await owner.createCrux({
        slug: randomUUID(),
        authorId: randomUUID(),
        homeId: randomUUID(),
      });
    }
    if (fault === 'closed')
      await owner.run(
        "UPDATE working_copies SET phase = 'archived' WHERE id = ?",
        [input.id],
      );
    if (fault === 'review')
      await owner.run(
        "UPDATE working_copies SET role = 'review' WHERE id = ?",
        [input.id],
      );
    if (fault === 'stale files')
      child.base.expected = { ...child.base.expected!, revision: 999 };
    if (fault === 'stale context') child.base.expectedMeta = { messages: [] };
    if (fault === 'ignored write')
      await owner.run(
        'CREATE TRIGGER refuse BEFORE INSERT ON working_copies BEGIN SELECT RAISE(IGNORE); END',
      );
    await expect(owner.createWorkingCopy(child, store)).rejects.toThrow();
    expect(
      await owner.get('SELECT id FROM working_copies WHERE id = ?', [child.id]),
    ).toBeUndefined();
    expect(
      await owner.get(
        'SELECT crux_id FROM file_content_heads WHERE crux_id = ?',
        [child.id],
      ),
    ).toBeUndefined();
    expect(
      await owner.all("SELECT id FROM dimensions WHERE type = 'growth'"),
    ).toEqual([]);
  });
  it.each(['dangling', 'foreign', 'cycle'])(
    'refuses %s retained source references on read and import',
    async (fault) => {
      await owner.createWorkingCopy(input, store);
      const graph = await owner.exportPrivateGraph(
        { roots: [main], includeMembers: false },
        store,
      );
      const sourceId = fault === 'cycle' ? input.id : randomUUID();
      if (fault === 'foreign') {
        const other = {
          ...graph.workingCopies[0],
          id: sourceId,
          taskId: randomUUID(),
          cruxId: randomUUID(),
        };
        graph.workingCopies.push(other);
      }
      graph.workingCopies[0].baseState.sourceId = sourceId;
      const target = await LocalGraphRuntime.create(join(dir, 'bad-source.db'));
      try {
        await expect(
          target.importPrivateGraph(
            {
              requestId: randomUUID(),
              mode: 'copy',
              destination: { authorId: randomUUID(), homeId: randomUUID() },
              graph,
            },
            store,
            store,
          ),
        ).rejects.toThrow();
        expect(await target.all('SELECT id FROM working_copies')).toEqual([]);
      } finally {
        await target.close();
      }
      await owner.run('UPDATE working_copies SET base_state = ? WHERE id = ?', [
        JSON.stringify(graph.workingCopies[0].baseState),
        input.id,
      ]);
      await expect(owner.workingCopyBase(input.id, store)).rejects.toThrow();
      await expect(
        inspectDesktopManifestRecovery(await owner.exportDatabase(), store),
      ).rejects.toThrow();
      await expect(
        owner.exportPrivateGraph(
          { roots: [main], includeMembers: false },
          store,
        ),
      ).rejects.toThrow();
    },
  );
  it.each([
    'files',
    'conversation',
    'missing bytes',
    'ignored base',
    'ignored head',
  ])('refuses %s atomically and permits a clean retry', async (fault) => {
    let repair = async () => {};
    if (fault === 'files')
      input.base.expected = { ...input.base.expected!, revision: 88 };
    if (fault === 'conversation') input.base.expectedMeta = { messages: [] };
    if (fault === 'missing bytes') {
      const root = input.base.expected!.root,
        bytes = objects.get(root)!;
      objects.delete(root);
      repair = async () => {
        objects.set(root, bytes);
      };
    }
    if (fault.startsWith('ignored')) {
      await owner.run(
        `CREATE TRIGGER refuse BEFORE INSERT ON ${fault === 'ignored base' ? 'working_copies' : 'file_content_heads'} BEGIN SELECT RAISE(IGNORE); END`,
      );
      repair = async () => {
        await owner.run('DROP TRIGGER refuse');
      };
    }
    await expect(owner.createWorkingCopy(input, store)).rejects.toThrow();
    expect(await owner.all('SELECT id FROM working_copies')).toEqual([]);
    expect(await owner.all('SELECT id FROM dimensions')).toEqual([]);
    expect(
      await owner.get(
        'SELECT crux_id FROM file_content_heads WHERE crux_id = ?',
        [input.id],
      ),
    ).toBeUndefined();
    await repair();
    input.base = {
      expected: await owner.fileContentHead(main),
      expectedMeta: (await owner.execute(({ crux }) => crux.findById(main)))
        .meta,
    };
    await owner.createWorkingCopy(input, store);
    expect(await owner.workingCopyBase(input.id, store)).toBeDefined();
  });
  it('exports and restores starting files retained only by the Task, after both heads and edit history move on', async () => {
    await owner.createWorkingCopy(input, store);
    const original = await owner.workingCopyBase(input.id, store);
    for (const id of [main, input.id])
      await owner.editFileContent(
        {
          cruxId: id,
          expected: await owner.fileContentHead(id),
          changes: [put('Later work')],
        },
        store,
      );
    await owner.run('DELETE FROM edit_history');
    expect(
      (await owner.all<any>('SELECT root FROM file_content_heads')).every(
        (row) => row.root !== original.root,
      ),
    ).toBe(true);
    const graph = await owner.exportPrivateGraph(
      { roots: [main], includeMembers: false },
      store,
    );
    expect(graph.graphVersion).toBe(3);
    expect(graph.fingerprints).toContain(original.root);
    const recovered = await inspectDesktopManifestRecovery(
      await owner.exportDatabase(),
      store,
    );
    expect(recovered.fingerprints).toContain(original.root);
    const target = await LocalGraphRuntime.create(join(dir, 'target.db'));
    const copied = new Map<string, Uint8Array>();
    const destination: DesktopContentStore = {
      read: async (id) => copied.get(id) ?? null,
      write: async (id, bytes) => {
        copied.set(id, bytes);
      },
    };
    try {
      const result = await target.importPrivateGraph(
        {
          requestId: randomUUID(),
          mode: 'copy',
          destination: { authorId: randomUUID(), homeId: randomUUID() },
          graph,
        },
        store,
        destination,
      );
      expect(
        await target.workingCopyBase(result.ids[input.id], destination),
      ).toEqual(original);
      expect(await target.all('SELECT id FROM dimensions')).toEqual([]);
      objects.delete(original.root);
      await expect(
        owner.exportPrivateGraph(
          { roots: [main], includeMembers: false },
          store,
        ),
      ).rejects.toThrow();
      await expect(
        inspectDesktopManifestRecovery(await owner.exportDatabase(), store),
      ).rejects.toThrow();
    } finally {
      await target.close();
    }
  });
});
