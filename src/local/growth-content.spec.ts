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
