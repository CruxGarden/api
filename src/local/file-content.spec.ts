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
