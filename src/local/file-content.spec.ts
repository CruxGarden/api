import { inspectDesktopRecovery } from './desktop-recovery';
import { createHash, randomUUID } from 'crypto';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { LocalGraphRuntime } from './graph-runtime';
import { DesktopContentStore } from './desktop-content';
import { FileManifest } from './file-manifest';

import { FILE_CONTENT_SCHEMA } from './file-content.repository';

describe('API file content publication', () => {
  let dir: string;
  let owner: LocalGraphRuntime;
  let id: string;
  let store: DesktopContentStore;
  let tree: FileManifest;
  async function root(text: string) {
    const bytes = Buffer.from(text);
    const fingerprint = createHash('sha256').update(bytes).digest('hex');
    await store.write(fingerprint, bytes);
    return tree.apply(null, [
      {
        put: {
          id: 'file-id',
          path: 'hello.txt',
          fingerprint,
          size: bytes.length,
          mimeType: 'text/plain',
          encoding: 'utf-8',
          mode: 0o644,
          attributes: {},
        },
      },
    ]);
  }
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'crux-file-content-'));
    mkdirSync(join(dir, 'objects'));
    store = {
      read: async (fp) => {
        try {
          return readFileSync(join(dir, 'objects', fp));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
          throw error;
        }
      },
      write: async (fp, bytes) => {
        writeFileSync(join(dir, 'objects', fp), bytes);
      },
    };
    tree = new FileManifest(store);
    owner = await LocalGraphRuntime.create(join(dir, 'garden.db'));
    await owner.run(FILE_CONTENT_SCHEMA);
    id = await owner.createCrux({
      title: 'Content',
      slug: randomUUID(),
      authorId: randomUUID(),
      homeId: randomUUID(),
    });
  });
  afterEach(async () => {
    await owner.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('publishes a verified root in the graph database and reopens the exact bytes after restart', async () => {
    const candidate = await root('Original bytes');
    const saved = await owner.commitFileContent(
      { cruxId: id, expected: null, root: candidate },
      store,
    );
    expect(saved).toEqual({
      cruxId: id,
      formatVersion: 1,
      root: candidate,
      revision: 1,
    });
    await owner.close();
    owner = await LocalGraphRuntime.open(join(dir, 'garden.db'));
    expect(await owner.fileContentHead(id)).toEqual(saved);
    const file = await tree.get(saved.root, 'hello.txt');
    expect(Buffer.from((await store.read(file!.fingerprint))!).toString()).toBe(
      'Original bytes',
    );
    expect(await owner.all('SELECT * FROM artifacts')).toEqual([]);
  });
  function put(path: string, text: string) {
    const bytes = Buffer.from(text);
    return {
      put: {
        id: `file:${path}`,
        path,
        fingerprint: createHash('sha256').update(bytes).digest('hex'),
        size: bytes.length,
        mimeType: 'application/octet-stream',
        encoding: 'binary',
        mode: 0o640,
        attributes: { label: 'Keep' },
      },
      bytes,
    };
  }
  it('creates, edits, renames and deletes files in atomic batches without Artifact rows', async () => {
    const a = put('one.bin', 'one\0');
    const b = put('two.bin', 'two');
    const first = await owner.editFileContent(
      { cruxId: id, expected: null, changes: [a, b] },
      store,
    );
    const changed = put('one.bin', 'edited');
    const second = await owner.editFileContent(
      {
        cruxId: id,
        expected: first,
        changes: [
          changed,
          { remove: 'two.bin' },
          { put: { ...b.put, path: 'renamed.bin' } },
        ],
      },
      store,
    );
    expect(second.revision).toBe(2);
    expect(await tree.entries(first.root)).toEqual([a.put, b.put]);
    expect(await tree.get(second.root, 'renamed.bin')).toEqual({
      ...b.put,
      path: 'renamed.bin',
    });
    expect(await tree.get(second.root, 'two.bin')).toBeNull();
    expect(
      Buffer.from(
        (await owner.readFileContent(
          { cruxId: id, expected: second, path: 'one.bin' },
          store,
        ))!.bytes,
      ).toString(),
    ).toBe('edited');
    const empty = await owner.editFileContent(
      {
        cruxId: id,
        expected: second,
        changes: [{ remove: 'one.bin' }, { remove: 'renamed.bin' }],
      },
      store,
    );
    expect(await tree.entries(empty.root)).toEqual([]);
    expect(await owner.all('SELECT * FROM artifacts')).toEqual([]);
  });
  it('refuses stale edit batches before accessing storage', async () => {
    const first = await owner.editFileContent(
      { cruxId: id, expected: null, changes: [put('one', 'one')] },
      store,
    );
    const read = jest.spyOn(store, 'read');
    const write = jest.spyOn(store, 'write');
    await expect(
      owner.editFileContent(
        { cruxId: id, expected: null, changes: [put('two', 'two')] },
        store,
      ),
    ).rejects.toThrow('File content changed');
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(await owner.fileContentHead(id)).toEqual(first);
  });
  it('retains the prior head after failed file staging and supports a retry', async () => {
    const first = await owner.editFileContent(
      { cruxId: id, expected: null, changes: [put('one', 'one')] },
      store,
    );
    const write = jest
      .spyOn(store, 'write')
      .mockRejectedValueOnce(new Error('Disk full'));
    const input = {
      cruxId: id,
      expected: first,
      changes: [put('one', 'replacement')],
    };
    await expect(owner.editFileContent(input, store)).rejects.toThrow(
      'Disk full',
    );
    expect(await owner.fileContentHead(id)).toEqual(first);
    write.mockRestore();
    expect((await owner.editFileContent(input, store)).revision).toBe(2);
  });
  it('retains staged bytes across failed SQL publication, restart and retry', async () => {
    const first = await owner.editFileContent(
      { cruxId: id, expected: null, changes: [put('one', 'one')] },
      store,
    );
    await owner.run(
      "CREATE TRIGGER refuse_edit BEFORE UPDATE ON file_content_heads BEGIN SELECT RAISE(ABORT, 'Refused edit'); END",
    );
    const input = {
      cruxId: id,
      expected: first,
      changes: [put('one', 'replacement')],
    };
    await expect(owner.editFileContent(input, store)).rejects.toThrow(
      'Refused edit',
    );
    await owner.close();
    owner = await LocalGraphRuntime.open(join(dir, 'garden.db'));
    expect(await owner.fileContentHead(id)).toEqual(first);
    expect(await store.read(input.changes[0].put.fingerprint)).toEqual(
      input.changes[0].bytes,
    );
    await owner.run('DROP TRIGGER refuse_edit');
    expect((await owner.editFileContent(input, store)).revision).toBe(2);
  });
  it('captures queued bytes, metadata and paths and refuses malformed batches before storage', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prior = owner.execute(async () => {
      await gate;
    });
    const file = put('one', 'one');
    const pending = owner.editFileContent(
      { cruxId: id, expected: null, changes: [file] },
      store,
    );
    file.bytes.fill(0);
    file.put.path = 'wrong';
    file.put.attributes.label = 'wrong';
    release();
    await prior;
    const head = await pending;
    const selected = await owner.readFileContent(
      { cruxId: id, expected: head, path: 'one' },
      store,
    );
    expect(Buffer.from(selected!.bytes).toString()).toBe('one');
    expect(selected!.entry.attributes.label).toBe('Keep');
    const read = jest.spyOn(store, 'read');
    const bad = put('two', 'two');
    bad.bytes.fill(0);
    await expect(
      owner.editFileContent(
        { cruxId: id, expected: head, changes: [bad] },
        store,
      ),
    ).rejects.toThrow('bytes');
    await expect(
      owner.editFileContent(
        {
          cruxId: id,
          expected: head,
          changes: [put('same', 'a'), put('same', 'b')],
        },
        store,
      ),
    ).rejects.toThrow('Duplicate');
    expect(read).not.toHaveBeenCalled();
  });

  it('reads exact verified file bytes through a version-bound API reference after restart', async () => {
    const head = await owner.commitFileContent(
      { cruxId: id, expected: null, root: await root('binary\0content') },
      store,
    );
    await owner.close();
    owner = await LocalGraphRuntime.open(join(dir, 'garden.db'));
    const read = jest.spyOn(store, 'read');
    const result = await owner.readFileContent(
      { cruxId: id, expected: head, path: 'hello.txt' },
      store,
    );
    expect(result!.head).toEqual(head);
    expect(result!.entry.path).toBe('hello.txt');
    expect(Buffer.from(result!.bytes).toString()).toBe('binary\0content');
    expect(read).toHaveBeenCalledTimes(2); // one leaf and one file, not full inventory
    expect(
      await owner.readFileContent(
        { cruxId: id, expected: head, path: 'absent' },
        store,
      ),
    ).toBeNull();
    expect(await owner.all('SELECT * FROM artifacts')).toEqual([]);
  });
  it('reads one path in a large manifest without loading unrelated files', async () => {
    const first = await root('Selected');
    const selected = (await tree.get(first, 'hello.txt'))!;
    const additions = Array.from({ length: 180 }, (_, n) => ({
      put: { ...selected, id: `other-${n}`, path: `others/${n}.txt` },
    }));
    const candidate = await tree.apply(first, additions);
    const head = await owner.commitFileContent(
      { cruxId: id, expected: null, root: candidate },
      store,
    );
    const read = jest.spyOn(store, 'read');
    const result = await owner.readFileContent(
      { cruxId: id, expected: head, path: 'hello.txt' },
      store,
    );
    expect(Buffer.from(result!.bytes).toString()).toBe('Selected');
    expect(read.mock.calls.length).toBeLessThanOrEqual(4);
    expect(read.mock.calls.length).toBeGreaterThan(2);
  });
  it('rejects malformed references and missing owners without reading content', async () => {
    const head = await owner.commitFileContent(
      { cruxId: id, expected: null, root: await root('Selected') },
      store,
    );
    const read = jest.spyOn(store, 'read');
    for (const expected of [
      null,
      { root: 'bad', revision: 1 },
      { root: head.root, revision: 0 },
      { root: head.root, revision: 1.5 },
    ])
      await expect(
        owner.readFileContent(
          { cruxId: id, expected, path: 'hello.txt' } as any,
          store,
        ),
      ).rejects.toThrow('version-bound');
    await expect(
      owner.readFileContent(
        { cruxId: 'absent', expected: head, path: 'hello.txt' },
        store,
      ),
    ).rejects.toThrow('Crux not found');
    await expect(
      owner.readFileContent(
        { cruxId: id, expected: head, path: '../escape' },
        store,
      ),
    ).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
  });

  it('refuses stale file reads before touching content instead of returning another version', async () => {
    const head = await owner.commitFileContent(
      { cruxId: id, expected: null, root: await root('Before') },
      store,
    );
    const after = await owner.commitFileContent(
      { cruxId: id, expected: head, root: await root('After') },
      store,
    );
    const read = jest.spyOn(store, 'read');
    await expect(
      owner.readFileContent(
        { cruxId: id, expected: head, path: 'hello.txt' },
        store,
      ),
    ).rejects.toThrow('File content changed');
    expect(read).not.toHaveBeenCalled();
    expect(
      Buffer.from(
        (await owner.readFileContent(
          { cruxId: id, expected: after, path: 'hello.txt' },
          store,
        ))!.bytes,
      ).toString(),
    ).toBe('After');
  });
  it('refuses corrupt or missing file bytes and keeps the published reference for retry', async () => {
    const head = await owner.commitFileContent(
      { cruxId: id, expected: null, root: await root('Retained') },
      store,
    );
    const file = (await tree.get(head.root, 'hello.txt'))!;
    const bytes = (await store.read(file.fingerprint))!;
    const request = { cruxId: id, expected: head, path: 'hello.txt' };
    await store.write(file.fingerprint, Buffer.from('corrupt'));
    await expect(owner.readFileContent(request, store)).rejects.toThrow(
      'integrity',
    );
    rmSync(join(dir, 'objects', file.fingerprint));
    await expect(owner.readFileContent(request, store)).rejects.toThrow(
      'Missing',
    );
    expect(await owner.fileContentHead(id)).toEqual(head);
    await store.write(file.fingerprint, bytes);
    expect(
      Buffer.from((await owner.readFileContent(request, store))!.bytes),
    ).toEqual(Buffer.from(bytes));
  });
  it('captures a queued file request and reader before the caller changes them', async () => {
    const head = await owner.commitFileContent(
      { cruxId: id, expected: null, root: await root('Captured') },
      store,
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prior = owner.execute(async () => {
      await gate;
    });
    const request = { cruxId: id, expected: { ...head }, path: 'hello.txt' };
    const pending = owner.readFileContent(request, store);
    request.cruxId = 'other';
    request.path = 'absent';
    request.expected.root = 'f'.repeat(64);
    store.read = async () => {
      throw new Error('mutated reader');
    };
    release();
    await prior;
    expect(Buffer.from((await pending)!.bytes).toString()).toBe('Captured');
  });

  it('refuses incomplete legacy recovery enumeration once a manifest root is committed', async () => {
    const imageBefore = await owner.exportDatabase();
    expect(inspectDesktopRecovery(imageBefore).fingerprints).toEqual([]);
    await owner.commitFileContent(
      { cruxId: id, expected: null, root: await root('Retained') },
      store,
    );
    const image = await owner.exportDatabase();
    expect(() => inspectDesktopRecovery(image)).toThrow(
      'manifest-aware recovery',
    );
  });

  it('serializes competing edits, refuses stale revisions and preserves old roots', async () => {
    const first = await owner.commitFileContent(
      { cruxId: id, expected: null, root: await root('First') },
      store,
    );
    const next = await root('Second');
    const alternative = await root('Third');
    const results = await Promise.allSettled([
      owner.commitFileContent(
        { cruxId: id, expected: first, root: next },
        store,
      ),
      owner.commitFileContent(
        { cruxId: id, expected: first, root: alternative },
        store,
      ),
    ]);
    expect(results.map((result) => result.status)).toEqual([
      'fulfilled',
      'rejected',
    ]);
    expect(await owner.fileContentHead(id)).toEqual({
      ...first,
      root: next,
      revision: 2,
    });
    for (const candidate of [first.root, next, alternative])
      await expect(tree.verify(candidate)).resolves.toHaveLength(2);
    const unchanged = await owner.commitFileContent(
      { cruxId: id, expected: { root: next, revision: 2 }, root: next },
      store,
    );
    expect(unchanged.revision).toBe(2);
  });

  it.each(['abort', 'ignore', 'alter'])(
    'rolls back a %s publication and retries without losing bytes',
    async (failure) => {
      const first = await owner.commitFileContent(
        { cruxId: id, expected: null, root: await root('First') },
        store,
      );
      const candidate = await root('Next');
      await owner.run("INSERT INTO settings VALUES ('keep', 'original')");
      const trigger =
        failure === 'abort'
          ? "BEFORE UPDATE ON file_content_heads BEGIN DELETE FROM settings; SELECT RAISE(ABORT, 'Injected failure'); END"
          : failure === 'ignore'
            ? 'BEFORE UPDATE ON file_content_heads BEGIN DELETE FROM settings; SELECT RAISE(IGNORE); END'
            : 'AFTER UPDATE ON file_content_heads BEGIN DELETE FROM settings; UPDATE file_content_heads SET revision = revision + 7 WHERE crux_id = NEW.crux_id; END';
      await owner.run('CREATE TRIGGER fail_content ' + trigger);
      await expect(
        owner.commitFileContent(
          { cruxId: id, expected: first, root: candidate },
          store,
        ),
      ).rejects.toThrow();
      expect(await owner.fileContentHead(id)).toEqual(first);
      expect(
        await owner.get('SELECT value FROM settings WHERE key = ?', ['keep']),
      ).toEqual({ value: 'original' });
      await owner.close();
      owner = await LocalGraphRuntime.open(join(dir, 'garden.db'));
      expect(await owner.fileContentHead(id)).toEqual(first);
      await owner.run('DROP TRIGGER fail_content');
      expect(
        (
          await owner.commitFileContent(
            { cruxId: id, expected: first, root: candidate },
            store,
          )
        ).revision,
      ).toBe(2);
      await expect(tree.verify(first.root)).resolves.toHaveLength(2);
      await expect(tree.verify(candidate)).resolves.toHaveLength(2);
    },
  );

  it.each(['missing', 'corrupt'])(
    'refuses %s candidate content without changing the head',
    async (fault) => {
      const first = await owner.commitFileContent(
        { cruxId: id, expected: null, root: await root('First') },
        store,
      );
      const candidate = await root('Other');
      const file = (await tree.get(candidate, 'hello.txt'))!;
      if (fault === 'missing') rmSync(join(dir, 'objects', file.fingerprint));
      else writeFileSync(join(dir, 'objects', file.fingerprint), 'Damaged');
      await expect(
        owner.commitFileContent(
          { cruxId: id, expected: first, root: candidate },
          store,
        ),
      ).rejects.toThrow();
      expect(await owner.fileContentHead(id)).toEqual(first);
      await expect(tree.verify(first.root)).resolves.toHaveLength(2);
    },
  );

  it('captures expected revision and root before queued work and drains publication before closing', async () => {
    const candidate = await root('Captured');
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prior = owner.execute(async () => {
      await blocked;
    });
    const request = { cruxId: id, expected: null, root: candidate };
    const pending = owner.commitFileContent(request, store);
    request.cruxId = randomUUID();
    request.root = 'f'.repeat(64);
    const closed = owner.close();
    release();
    await Promise.all([prior, pending, closed]);
    owner = await LocalGraphRuntime.open(join(dir, 'garden.db'));
    expect((await owner.fileContentHead(id))!.root).toBe(candidate);
  });

  it.each(['missing', 'trash', 'snapshot', 'files', 'task', 'growth'])(
    'refuses %s owners before touching candidate storage',
    async (state) => {
      const candidate = await root('Candidate');
      if (state === 'missing')
        await owner.run('DELETE FROM cruxes WHERE id = ?', [id]);
      if (state === 'trash') await owner.setCruxTrashed(id, true);
      if (state === 'snapshot')
        await owner.run("UPDATE cruxes SET kind = 'snapshot' WHERE id = ?", [
          id,
        ]);
      if (state === 'files')
        await owner.run(
          "INSERT INTO artifacts (id, resource_id, author_id, home_id, created, updated) VALUES ('file', ?, 'author', 'home', 'now', 'now')",
          [id],
        );
      if (state === 'task')
        await owner.run(
          "INSERT INTO working_copies (id, crux_id, task_id, title, base_snapshot_id, created, updated) VALUES ('copy', ?, 'task', 'Task', 'base', 'now', 'now')",
          [id],
        );
      if (state === 'growth')
        await owner.execute(async ({ dimension }) => {
          await dimension.create({
            sourceId: id,
            targetId: randomUUID(),
            type: 'growth' as any,
            authorId: randomUUID(),
            homeId: randomUUID(),
          });
        });
      const read = jest.spyOn(store, 'read');
      await expect(
        owner.commitFileContent(
          { cruxId: id, expected: null, root: candidate },
          store,
        ),
      ).rejects.toThrow();
      expect(read).not.toHaveBeenCalled();
      expect(await owner.all('SELECT * FROM file_content_heads')).toEqual([]);
    },
  );

  it('refuses unadopted schemas and invalid input without poisoning the API owner', async () => {
    for (const expected of [
      undefined,
      {},
      { root: 'a'.repeat(64), revision: -1 },
      { root: 'a'.repeat(64), revision: Number.MAX_SAFE_INTEGER },
    ])
      await expect(
        owner.commitFileContent(
          { cruxId: id, expected: expected as any, root: 'b'.repeat(64) },
          store,
        ),
      ).rejects.toThrow();
    await owner.run('DROP TABLE file_content_heads');
    await expect(
      owner.commitFileContent(
        { cruxId: id, expected: null, root: await root('Unused') },
        store,
      ),
    ).rejects.toThrow('not been adopted');
    await owner.updateCrux(id, { title: 'Still usable' });
    expect((await owner.execute(({ crux }) => crux.findById(id))).title).toBe(
      'Still usable',
    );
  });
});
