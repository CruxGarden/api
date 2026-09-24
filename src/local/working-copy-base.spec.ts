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
    expect(graph.graphVersion).toBe(2);
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
