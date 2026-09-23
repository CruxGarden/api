import { createHash } from 'crypto';
import { FileManifest, FileEntry } from './file-manifest';
import { DesktopContentStore } from './desktop-content';

const hash = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
function fixture() {
  const objects = new Map<string, Uint8Array>();
  const store: DesktopContentStore = {
    read: jest.fn(async (id) => objects.get(id) ?? null),
    write: jest.fn(async (id, bytes) => {
      objects.set(id, Uint8Array.from(bytes));
    }),
  };
  function file(path: string, content = path): FileEntry {
    const bytes = Buffer.from(content);
    const fingerprint = hash(bytes);
    objects.set(fingerprint, bytes);
    return {
      id: `file:${path}`,
      path,
      fingerprint,
      size: bytes.length,
      mimeType: 'text/plain',
      encoding: 'utf-8',
      mode: 0o644,
      attributes: { authorId: 'author', meta: { nested: ['preserve', null] } },
    };
  }
  return { objects, store, file, tree: new FileManifest(store) };
}

describe('immutable file manifests', () => {
  it('produces the same root across insertion order and batch boundaries', async () => {
    const { tree, file } = fixture();
    const files = Array.from({ length: 180 }, (_, i) => file(`dir/${i}.txt`));
    const all = await tree.apply(
      null,
      files.map((put) => ({ put })),
    );
    let staged = await tree.apply(null, []);
    for (let i = files.length; i > 0; i -= 30)
      staged = await tree.apply(
        staged,
        files
          .slice(Math.max(0, i - 30), i)
          .reverse()
          .map((put) => ({ put })),
      );
    expect(staged).toBe(all);
    expect(await tree.get(all, files[0].path)).toEqual(files[0]);
    expect(await tree.get(all, 'absent')).toBeNull();
    expect((await tree.entries(all)).length).toBe(180);
  });

  it('keeps old roots exact and reuses untouched subtrees after edit, rename and delete', async () => {
    const { tree, file, store } = fixture();
    const files = Array.from({ length: 1000 }, (_, i) => file(`dir/${i}.txt`));
    const before = await tree.apply(
      null,
      files.map((put) => ({ put })),
    );
    jest.mocked(store.write).mockClear();
    const changed = { ...file(files[0].path, 'new bytes'), mode: 0o755 };
    const renamed = { ...files[1], path: 'other/renamed.txt' };
    const after = await tree.apply(before, [
      { put: changed },
      { remove: files[1].path },
      { put: renamed },
      { remove: files[2].path },
    ]);
    expect(jest.mocked(store.write).mock.calls.length).toBeLessThan(16);
    expect(await tree.get(before, files[0].path)).toEqual(files[0]);
    expect(await tree.get(after, files[0].path)).toEqual(changed);
    expect(await tree.get(after, renamed.path)).toEqual(renamed);
    expect(await tree.get(after, files[1].path)).toBeNull();
    const rebuilt = await tree.apply(
      null,
      [changed, renamed, ...files.slice(3)].map((put) => ({ put })),
    );
    expect(after).toBe(rebuilt);
  });

  it('collapses branches deterministically and makes unchanged writes idempotent', async () => {
    const { tree, file, store } = fixture();
    const files = Array.from({ length: 90 }, (_, i) => file(`${i}`));
    const root = await tree.apply(
      null,
      files.map((put) => ({ put })),
    );
    const shrunk = await tree.apply(
      root,
      files.slice(10).map((f) => ({ remove: f.path })),
    );
    expect(shrunk).toBe(
      await tree.apply(
        null,
        files.slice(0, 10).map((put) => ({ put })),
      ),
    );
    jest.mocked(store.write).mockClear();
    expect(
      await tree.apply(shrunk, [{ put: files[0] }, { remove: 'missing' }]),
    ).toBe(shrunk);
    expect(store.write).not.toHaveBeenCalled();
    const empty = await tree.apply(
      shrunk,
      files.slice(0, 10).map((f) => ({ remove: f.path })),
    );
    expect(empty).toBe(await tree.apply(null, []));
  });

  it('preserves binary bytes, Unicode paths, logical identity and extension metadata', async () => {
    const { tree, objects, file } = fixture();
    const bytes = Uint8Array.from([0, 255, 128, 10]);
    const fingerprint = hash(bytes);
    objects.set(fingerprint, bytes);
    const entry = {
      ...file('絵/café.bin'),
      fingerprint,
      size: bytes.length,
      encoding: 'binary',
      mimeType: 'application/octet-stream',
      mode: 0o750,
      attributes: {
        nullValue: null,
        number: 1.25,
        custom: { z: 'last', a: 'first' },
      },
    };
    const root = await tree.apply(null, [{ put: entry }]);
    expect(await tree.get(root, entry.path)).toEqual(entry);
    const refs = await tree.verify(root);
    expect(refs).toContain(root);
    expect(refs).toContain(fingerprint);
    expect(objects.get(fingerprint)).toEqual(bytes);
  });

  it('captures inputs before storage yields', async () => {
    const { tree, file, store } = fixture();
    const entry = file('kept.txt');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const read = store.read;
    store.read = async (id) => {
      await gate;
      return read(id);
    };
    const saving = tree.apply(null, [{ put: entry }]);
    entry.path = 'redirected.txt';
    entry.attributes = { lost: true };
    release();
    const root = await saving;
    expect((await tree.get(root, 'kept.txt'))?.attributes).toEqual({
      authorId: 'author',
      meta: { nested: ['preserve', null] },
    });
    expect(await tree.get(root, 'redirected.txt')).toBeNull();
  });

  it('refuses missing, corrupt or wrong-sized new file bytes before staging', async () => {
    const { tree, file, store, objects } = fixture();
    const entry = file('file');
    objects.delete(entry.fingerprint);
    await expect(tree.apply(null, [{ put: entry }])).rejects.toThrow(/Missing/);
    objects.set(entry.fingerprint, Buffer.from('wrong'));
    await expect(tree.apply(null, [{ put: entry }])).rejects.toThrow(
      /integrity/,
    );
    const valid = file('file');
    await expect(
      tree.apply(null, [{ put: { ...valid, size: 999 } }]),
    ).rejects.toThrow(/size/);
    expect(store.write).not.toHaveBeenCalled();
  });

  it('refuses failed or silently corrupted object writes without damaging old roots', async () => {
    const { tree, file, store, objects } = fixture();
    const first = file('kept');
    const root = await tree.apply(null, [{ put: first }]);
    const second = file('new');
    store.write = async () => {
      throw new Error('disk full');
    };
    await expect(tree.apply(root, [{ put: second }])).rejects.toThrow(
      'disk full',
    );
    expect(await tree.get(root, 'kept')).toEqual(first);
    store.write = async (id) => {
      objects.set(id, Buffer.from('corrupt'));
    };
    await expect(tree.apply(root, [{ put: second }])).rejects.toThrow(
      /integrity/,
    );
    expect(await tree.get(root, 'kept')).toEqual(first);
  });

  it('verifies complete imported trees and fails on missing descendants or payloads', async () => {
    const { tree, file, objects } = fixture();
    const files = Array.from({ length: 100 }, (_, i) => file(`${i}`));
    const root = await tree.apply(
      null,
      files.map((put) => ({ put })),
    );
    const refs = await tree.verify(root);
    const child = refs.find(
      (id) => id !== root && !files.some((f) => f.fingerprint === id),
    )!;
    const saved = objects.get(child)!;
    objects.delete(child);
    await expect(tree.verify(root)).rejects.toThrow(/Missing/);
    objects.set(child, saved);
    objects.delete(files[0].fingerprint);
    await expect(tree.verify(root)).rejects.toThrow(/Missing/);
  });

  it('rejects unsafe paths, ambiguous edits and unsupported metadata without writing', async () => {
    const { tree, file, store } = fixture();
    for (const path of [
      '../escape',
      '/absolute',
      'a//b',
      'a\\b',
      'a/./b',
      'a\0b',
      '\ud800',
    ])
      await expect(tree.apply(null, [{ put: file(path) }])).rejects.toThrow();
    const entry = file('okay');
    await expect(
      tree.apply(null, [{ put: entry }, { remove: entry.path }]),
    ).rejects.toThrow(/Duplicate/);
    await expect(
      tree.apply(null, [{ put: { ...entry, attributes: { n: NaN } } }]),
    ).rejects.toThrow();
    await expect(
      tree.apply(null, [{ put: { ...entry, size: -1 } }]),
    ).rejects.toThrow();
    expect(store.write).not.toHaveBeenCalled();
  });

  it('rejects hash-valid unknown versions and inconsistent manifest shapes', async () => {
    const { tree, objects } = fixture();
    for (const value of [
      { version: 2, type: 'leaf', entries: [] },
      { version: 1, type: 'branch', children: [] },
      { version: 1, type: 'leaf', entries: [], extra: true },
    ]) {
      const bytes = Buffer.from(JSON.stringify(value));
      const root = hash(bytes);
      objects.set(root, bytes);
      await expect(tree.entries(root)).rejects.toThrow();
    }
  });
  it('keeps canonical roots through repeated mixed edits and preserves every retained version', async () => {
    const { tree, file } = fixture();
    const current = new Map(
      Array.from({ length: 200 }, (_, i) => {
        const value = file(`file-${i}`);
        return [value.path, value];
      }),
    );
    let root = await tree.apply(
      null,
      [...current.values()].map((put) => ({ put })),
    );
    const retained: { root: string; entries: FileEntry[] }[] = [];
    for (let step = 0; step < 30; step++) {
      retained.push({
        root,
        entries: [...current.values()].sort((a, b) =>
          a.path < b.path ? -1 : 1,
        ),
      });
      const changed = file(`file-${step}`, `changed-${step}`);
      const removed = `file-${100 + step}`;
      const added = {
        ...file(`nested/new-${step}`),
        attributes: { custom: step, original: { retained: true } },
      };
      current.set(changed.path, changed);
      current.delete(removed);
      current.set(added.path, added);
      root = await tree.apply(root, [
        { put: added },
        { remove: removed },
        { put: changed },
      ]);
      expect(root).toBe(
        await tree.apply(
          null,
          [...current.values()].reverse().map((put) => ({ put })),
        ),
      );
    }
    for (const old of retained)
      expect(await tree.entries(old.root)).toEqual(old.entries);
  });

  it('rejects incorrect child counts and misplaced entries even with valid object hashes', async () => {
    const { tree, file, objects } = fixture();
    const root = await tree.apply(
      null,
      Array.from({ length: 100 }, (_, i) => ({ put: file(`${i}`) })),
    );
    const original = JSON.parse(Buffer.from(objects.get(root)!).toString());
    const save = (value: unknown) => {
      const bytes = Buffer.from(JSON.stringify(value));
      const id = hash(bytes);
      objects.set(id, bytes);
      return id;
    };
    const countChanged = structuredClone(original);
    countChanged.children[0].count++;
    await expect(tree.verify(save(countChanged))).rejects.toThrow(
      /count mismatch/,
    );
    const misplaced = structuredClone(original);
    const first = misplaced.children[0];
    const second = misplaced.children[1];
    first.hash = second.hash;
    first.count = second.count;
    await expect(tree.verify(save(misplaced))).rejects.toThrow(
      /path partition/,
    );
  });

  it('preserves case and normalization differences for explicit projection policy', async () => {
    const { tree, file } = fixture();
    const names = ['Readme', 'README', 'caf\u00e9', 'cafe\u0301'];
    const root = await tree.apply(
      null,
      names.map((name) => ({ put: file(name) })),
    );
    expect((await tree.entries(root)).map((entry) => entry.path)).toEqual(
      names.sort(),
    );
  });
  it('refuses hash-valid objects containing malformed UTF-8 rather than changing their metadata', async () => {
    const { tree, file, objects } = fixture();
    const root = await tree.apply(null, [
      { put: { ...file('file'), attributes: { marker: 'X' } } },
    ]);
    const bytes = Buffer.from(objects.get(root)!);
    const marker = bytes.indexOf('"marker":"X"');
    expect(marker).toBeGreaterThan(0);
    bytes[marker + 10] = 255;
    const invalid = hash(bytes);
    objects.set(invalid, bytes);
    await expect(tree.entries(invalid)).rejects.toThrow(/UTF-8/);
  });
});
