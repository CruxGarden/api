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
        safety: request(),
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

  it('admits only the reviewed Task files and retains a recoverable merge through restart', async () => {
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
      await owner.prepareWorkingCopyFolder(copyId, 0, () => `/owned/${copyId}`);
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
    const asManifest = (text: string) => {
      const { fingerprint, mode, encoding, mimeType, size } = put(text).put;
      return { 'hello.txt': { fingerprint, mode, encoding, mimeType, size } };
    };
    const mergeId = randomUUID();
    const review = {
      id: mergeId,
      cruxId: id,
      copyId,
      candidateId,
      phase: 'review',
      sourceHead: task.snapshot.id,
      targetHead: base.snapshot.id,
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
    await owner.updateCrux(id, { meta: { projectFolder: '/owned/main' } });
    await owner.saveTaskReview(JSON.stringify(review));
    await (owner.beginTaskMerge as any)(mergeId, JSON.stringify(review), store);
    const mergedHead = (await owner.fileContentHead(id))!;
    expect(mergedHead.root).toBe(
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
      expect(entries).toEqual([taskFile.put]);
    });
    await owner.finishContentProjection(id, store, apply);
    expect(apply).toHaveBeenCalledTimes(1);
    const merge = {
      id: mergeId,
      copyId,
      sourceHead: task.snapshot.id,
      targetHead: base.snapshot.id,
      verifiedKey: review.verifiedKey,
      resolutions: {},
    };
    const result = await owner.createGrowthSnapshot(
      {
        ...request(),
        expected: mergedHead,
        parentId: base.snapshot.id,
        meta: { merge },
      },
      store,
    );
    await owner.completeTaskMerge(mergeId, result.snapshot.id);
    expect(
      (
        await owner.get<any>('SELECT phase FROM working_copies WHERE id = ?', [
          copyId,
        ])
      ).phase,
    ).toBe('merged');
    expect(await owner.fileContentHead(base.snapshot.id)).toEqual(base.head);
    expect(await owner.all('SELECT * FROM artifacts')).toEqual([]);
  });

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
            safety: request(),
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
        safety: request(),
        target: { cruxId: base.snapshot.id, expected: base.head },
        workspace: { expectedMeta: before.meta, messages: [] },
      },
      store,
    );
    await owner.updateCrux(id, {
      meta: { projectFolder: '/owned/replacement' },
    });
    const apply = jest.fn(async () => {});
    await expect(
      owner.finishContentProjection(id, store, apply),
    ).rejects.toThrow('Folder');
    expect(apply).not.toHaveBeenCalled();
    await owner.updateCrux(id, { meta: { projectFolder: '/owned/original' } });
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

  it('restores retained content and captures the previous root in the same transaction, without copying bytes', async () => {
    const target = await owner.createGrowthSnapshot(request(), store);
    head = await owner.editFileContent(
      { cruxId: id, expected: head, changes: [put('Current work')] },
      store,
    );
    const currentHead = head;
    const safety = {
      ...request(),
      parentId: target.snapshot.id,
      title: 'Before revert',
    };
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
    expect(result.safety.head).toEqual({
      ...currentHead,
      cruxId: safety.snapshotId,
      revision: 1,
    });
    expect(result.safety.snapshot.meta.messages).toEqual(safety.meta.messages);
    expect(result.safety.growth).toMatchObject({
      sourceId: id,
      targetId: safety.snapshotId,
      type: 'growth',
    });
    expect(write).not.toHaveBeenCalled();
    expect(await owner.all('SELECT * FROM artifacts')).toEqual([]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ id, fields: ['growth', 'fileContent'] });
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
    expect(await read(safety.snapshotId, result.safety.head)).toBe(
      'Current work',
    );
    expect(await read(target.snapshot.id, target.head)).toBe('First\0version');
  });

  it.each([
    [
      'safety node',
      "BEFORE INSERT ON cruxes WHEN NEW.kind = 'snapshot' BEGIN SELECT RAISE(ABORT, 'Safety refused'); END",
    ],
    [
      'safety edge',
      'BEFORE INSERT ON dimensions BEGIN SELECT RAISE(IGNORE); END',
    ],
    [
      'live root',
      'BEFORE UPDATE ON file_content_heads BEGIN SELECT RAISE(IGNORE); END',
    ],
    [
      'late safety alteration',
      "AFTER UPDATE ON file_content_heads BEGIN UPDATE cruxes SET meta = '{}' WHERE kind = 'snapshot'; END",
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
        safety: request(),
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
        await owner.get('SELECT id FROM cruxes WHERE id = ?', [
          input.safety.snapshotId,
        ]),
      ).toBeUndefined();
      expect(await owner.all('SELECT * FROM dimensions')).toHaveLength(1);
      expect(notices).not.toHaveBeenCalled();
      await owner.close();
      owner = await LocalGraphRuntime.open(join(dir, 'garden.db'));
      expect(await owner.fileContentHead(id)).toEqual(head);
      await owner.run('DROP TRIGGER refuse_restore');
      const result = await owner.restoreGrowthContent(input, store);
      expect(result.head.root).toBe(target.head.root);
      expect(result.safety.head.root).toBe(head.root);
    },
  );

  it('refuses stale or foreign selections before content reads and missing bytes before any graph changes', async () => {
    const target = await owner.createGrowthSnapshot(request(), store);
    head = await owner.editFileContent(
      { cruxId: id, expected: head, changes: [put('Current work')] },
      store,
    );
    const input = {
      safety: request(),
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
        await owner.get('SELECT id FROM cruxes WHERE id = ?', [
          input.safety.snapshotId,
        ]),
      ).toBeUndefined();
      objects.set(fp, bytes);
    }
    await expect(
      owner.restoreGrowthContent(input, store),
    ).resolves.toMatchObject({ head: { root: target.head.root } });
  });

  it('captures the queued restore selections, safety metadata and storage reader', async () => {
    const target = await owner.createGrowthSnapshot(request(), store);
    head = await owner.editFileContent(
      { cruxId: id, expected: head, changes: [put('Current work')] },
      store,
    );
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocker = owner.execute(async () => {
      await wait;
    });
    const input = {
      safety: request(),
      target: { cruxId: target.snapshot.id, expected: { ...target.head } },
    };
    const original = structuredClone(input);
    const pending = owner.restoreGrowthContent(input, store);
    input.target.cruxId = id;
    input.target.expected.root = '0'.repeat(64);
    input.safety.expected.revision = 100;
    input.safety.meta.messages[0].content = 'Changed after submission';
    store.read = async () => {
      throw new Error('Reader replaced');
    };
    release();
    await blocker;
    const result = await pending;
    expect(result.head.root).toBe(target.head.root);
    expect(result.safety.snapshot.meta.messages).toEqual(
      original.safety.meta.messages,
    );
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
