import { inspectDesktopManifestRecovery } from './desktop-recovery';
import {
  packPrivateGraph,
  openPrivateGraphArchive,
} from './private-graph-archive';
import { createHash, randomUUID } from 'crypto';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { LocalGraphRuntime } from './graph-runtime';

describe('edit history outside the Crux graph', () => {
  let dir: string;
  let runtime: LocalGraphRuntime;
  let cruxId: string;
  const blobs = new Map<string, Uint8Array>();
  const store = {
    read: async (fp: string) => blobs.get(fp) ?? null,
    write: async (fp: string, bytes: Uint8Array) => {
      blobs.set(fp, Uint8Array.from(bytes));
    },
  };
  const edit = async (value: string) => {
    const bytes = new TextEncoder().encode(value);
    return runtime.editFileContent(
      {
        cruxId,
        expected: await runtime.fileContentHead(cruxId),
        changes: [
          {
            put: {
              id: 'file',
              path: 'work.txt',
              fingerprint: createHash('sha256').update(bytes).digest('hex'),
              size: bytes.length,
              encoding: 'utf-8',
              mimeType: 'text/plain',
              mode: 0o644,
              attributes: {},
            },
            bytes,
          },
        ],
      },
      store,
    );
  };
  const capture = async () =>
    runtime.createEditCheckpoint(
      { cruxId, expected: await runtime.fileContentHead(cruxId) },
      store,
    );
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'crux-edit-history-'));
    blobs.clear();
    runtime = await LocalGraphRuntime.create(join(dir, 'garden.db'));
    cruxId = await runtime.createCrux({
      slug: 'work',
      authorId: randomUUID(),
      homeId: randomUUID(),
    });
  });
  afterEach(async () => {
    await runtime.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps bounded recoverable roots in one owner record, without Growth edges or Crux nodes', async () => {
    for (let i = 0; i < 25; i++) {
      await edit(String(i));
      await capture();
    }
    const history = await runtime.listEditHistory(cruxId);
    expect(history.checkpoints).toHaveLength(20);
    expect(await runtime.all('SELECT id FROM cruxes')).toHaveLength(1);
    expect(await runtime.all('SELECT id FROM dimensions')).toEqual([]);
    expect(await runtime.all('SELECT crux_id FROM edit_history')).toHaveLength(
      1,
    );
    await runtime.close();
    runtime = await LocalGraphRuntime.open(join(dir, 'garden.db'));
    expect(await runtime.listEditHistory(cruxId)).toEqual(history);
  });

  it('protects an explicit safety capture before destructive work from automatic eviction', async () => {
    const head = await edit('keep this before deleting');
    const request = { cruxId, expected: head, reason: 'safety' as const };
    const safety = await runtime.createEditCheckpoint(request, store);
    expect(safety.reason).toBe('safety');
    for (let i = 0; i < 25; i++) {
      await edit(String(i));
      await capture();
    }
    expect((await runtime.listEditHistory(cruxId)).checkpoints).toContainEqual(
      safety,
    );
    expect(
      (await runtime.inspectEditCheckpoint(cruxId, safety.id, store)).files,
    ).toHaveLength(1);
    expect(await runtime.all('SELECT id FROM dimensions')).toEqual([]);
    expect(await runtime.all('SELECT id FROM cruxes')).toHaveLength(1);
  });

  it('deduplicates unchanged captures and refuses stale content without losing history', async () => {
    const first = await edit('one');
    const checkpoint = await capture();
    expect(
      (
        await runtime.inspectEditCheckpoint(cruxId, checkpoint.id, store)
      ).files.map((file) => file.path),
    ).toEqual(['work.txt']);
    expect(await capture()).toEqual(checkpoint);
    await edit('two');
    await expect(
      runtime.createEditCheckpoint({ cruxId, expected: first }, store),
    ).rejects.toThrow();
    expect((await runtime.listEditHistory(cruxId)).checkpoints).toHaveLength(1);
  });

  it('restores files atomically, keeps the conversation and protects the pre-restore safety root from retention', async () => {
    await edit('rough');
    const checkpoint = await capture();
    const before = await edit('current');
    await runtime.mergeCruxMeta(cruxId, {
      messages: [{ role: 'user', content: 'Keep the conversation' }],
    });
    const result = await runtime.restoreEditCheckpoint(
      { cruxId, expected: before, checkpointId: checkpoint.id },
      store,
    );
    expect(result.head.root).toBe(checkpoint.root);
    expect(result.safety.root).toBe(before.root);
    expect(
      (await runtime.execute(({ crux }) => crux.findById(cruxId))).meta
        .messages,
    ).toEqual([{ role: 'user', content: 'Keep the conversation' }]);
    for (let i = 0; i < 25; i++) {
      await edit(String(i));
      await capture();
    }
    const kept = (await runtime.listEditHistory(cruxId)).checkpoints;
    expect(kept.filter((item) => item.reason === 'autosave')).toHaveLength(20);
    expect(kept.find((item) => item.id === result.safety.id)?.root).toBe(
      before.root,
    );
    expect(await runtime.all('SELECT id FROM dimensions')).toEqual([]);
  });

  it('rolls back a restore and its safety capture when publication fails', async () => {
    await edit('rough');
    const checkpoint = await capture();
    const before = await edit('current');
    const history = await runtime.listEditHistory(cruxId);
    await runtime.run(
      "CREATE TRIGGER refuse_history_restore BEFORE UPDATE ON file_content_heads BEGIN SELECT RAISE(ABORT, 'refused'); END",
    );
    await expect(
      runtime.restoreEditCheckpoint(
        { cruxId, expected: before, checkpointId: checkpoint.id },
        store,
      ),
    ).rejects.toThrow();
    expect(await runtime.fileContentHead(cruxId)).toEqual(before);
    expect(await runtime.listEditHistory(cruxId)).toEqual(history);
  });
  it('retains history-only content through both archive forms and copies checkpoints without graph nodes', async () => {
    await edit('history only');
    const old = await capture();
    await edit('current');
    const selection = { roots: [cruxId], includeMembers: false };
    const graph = await runtime.exportPrivateGraph(selection, store);
    expect(graph.editHistory?.[0].checkpoints[0].root).toBe(old.root);
    const bytes = await packPrivateGraph(graph, store);
    const opened = await openPrivateGraphArchive(bytes);
    const target = await LocalGraphRuntime.create(join(dir, 'copy.db'));
    const destination = new Map<string, Uint8Array>();
    try {
      const copied = await target.importPrivateGraph(
        {
          requestId: randomUUID(),
          mode: 'copy',
          destination: { authorId: randomUUID(), homeId: randomUUID() },
          graph: opened.graph,
        },
        opened.content,
        {
          read: async (fp) => destination.get(fp) ?? null,
          write: async (fp, data) => {
            destination.set(fp, Uint8Array.from(data));
          },
        },
      );
      const history = await target.listEditHistory(copied.roots[0]);
      expect(history.checkpoints[0].root).toBe(old.root);
      expect(history.checkpoints[0].id).not.toBe(old.id);
      expect(await target.all('SELECT id FROM dimensions')).toEqual([]);
      expect(await target.all('SELECT id FROM cruxes')).toHaveLength(1);
      expect(destination.has(old.root)).toBe(true);
    } finally {
      await target.close();
    }
    const image = await runtime.exportDatabase();
    const inspected = await inspectDesktopManifestRecovery(image, store);
    expect(inspected.fingerprints).toContain(old.root);
    const held = blobs.get(old.root)!;
    blobs.delete(old.root);
    await expect(
      inspectDesktopManifestRecovery(image, store),
    ).rejects.toThrow();
    await expect(
      runtime.exportPrivateGraph(selection, store),
    ).rejects.toThrow();
    blobs.set(old.root, held);
    expect(
      (await runtime.exportPrivateGraph(selection, store)).editHistory,
    ).toEqual(graph.editHistory);
  });

  it('refuses ignored history writes without evicting older recovery points', async () => {
    await edit('one');
    await capture();
    const history = await runtime.listEditHistory(cruxId);
    await edit('two');
    await runtime.run(
      'CREATE TRIGGER ignore_history BEFORE UPDATE ON edit_history BEGIN SELECT RAISE(IGNORE); END',
    );
    await expect(capture()).rejects.toThrow();
    expect(await runtime.listEditHistory(cruxId)).toEqual(history);
    await runtime.run('DROP TRIGGER ignore_history');
    await capture();
    expect((await runtime.listEditHistory(cruxId)).checkpoints).toHaveLength(2);
  });

  it('requires pending disk recovery before another edit and refuses a foreign checkpoint', async () => {
    await edit('one');
    const checkpoint = await capture();
    const before = await edit('two');
    await expect(
      runtime.restoreEditCheckpoint(
        { cruxId, expected: before, checkpointId: randomUUID() },
        store,
      ),
    ).rejects.toThrow('no longer retained');
    await runtime.mergeCruxMeta(cruxId, {
      projectFolder: join(dir, 'project'),
    });
    await runtime.restoreEditCheckpoint(
      { cruxId, expected: before, checkpointId: checkpoint.id },
      store,
    );
    await expect(edit('three')).rejects.toThrow('projection');
  });

  it('adds the history ring to a current schema-5 database without changing its saved content', async () => {
    const head = await edit('keep');
    await runtime.close();
    const Database = require('better-sqlite3');
    const db = new Database(join(dir, 'garden.db'));
    db.exec('DROP TABLE edit_history; UPDATE schema_version SET version = 5;');
    const oldImage = Uint8Array.from(db.serialize()).buffer;
    db.close();
    runtime = await LocalGraphRuntime.open(join(dir, 'garden.db'));
    expect(await runtime.get('SELECT version FROM schema_version')).toEqual({
      version: 6,
    });
    expect(await runtime.fileContentHead(cruxId)).toEqual(head);
    expect((await runtime.listEditHistory(cruxId)).checkpoints).toEqual([]);
    await capture();
    await runtime.replaceDatabaseWithContent(oldImage, store);
    expect(await runtime.get('SELECT version FROM schema_version')).toEqual({
      version: 6,
    });
    expect(await runtime.fileContentHead(cruxId)).toEqual(head);
  });
  it('coalesces routine writes to one recovery point per minute, without scanning unchanged file trees', async () => {
    const first = await edit('first');
    const now = jest.spyOn(Date, 'now').mockReturnValue(100_000);
    try {
      await edit('second');
      await edit('third');
      expect(
        (await runtime.listEditHistory(cruxId)).checkpoints.map(
          (item) => item.root,
        ),
      ).toEqual([first.root]);
      now.mockReturnValue(160_000);
      const third = await runtime.fileContentHead(cruxId);
      await edit('fourth');
      expect(
        (await runtime.listEditHistory(cruxId)).checkpoints.map(
          (item) => item.root,
        ),
      ).toEqual([first.root, third!.root]);
    } finally {
      now.mockRestore();
    }
  });

  it('keeps intentional Growth content independent of edit-history eviction', async () => {
    const original = await edit('rough mix');
    const growth = await runtime.createGrowthSnapshot(
      {
        cruxId,
        expected: original,
        snapshotId: randomUUID(),
        parentId: null,
        title: 'rough mix',
      },
      store,
    );
    await capture();
    for (let i = 0; i < 25; i++) {
      await edit(String(i));
      await capture();
    }
    expect(
      (await runtime.listEditHistory(cruxId)).checkpoints.some(
        (item) => item.root === original.root,
      ),
    ).toBe(false);
    expect((await runtime.fileContentHead(growth.snapshot.id))!.root).toBe(
      original.root,
    );
    const graph = await runtime.exportPrivateGraph(
      { roots: [cruxId], includeMembers: false },
      store,
    );
    expect(graph.fingerprints).toContain(original.root);
    expect(graph.dimensions).toHaveLength(1);
  });
});
