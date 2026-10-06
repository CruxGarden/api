import { createHash, randomUUID } from 'crypto';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { LocalGraphRuntime } from './graph-runtime';
import { FileManifest, FileEntry } from './file-manifest';

// Real SQLite, filesystem and content-addressed bytes; host callbacks mirror
// the privileged host boundary. Desktop tests additionally exercise ProjectFolders.
describe('native rename projection', () => {
  let dir: string;
  let folder: string;
  let runtime: LocalGraphRuntime;
  let cruxId: string;
  let source: FileEntry;
  let target: FileEntry;
  const hash = (bytes: Uint8Array) =>
    createHash('sha256').update(bytes).digest('hex');
  const store = {
    read: async (fp: string) =>
      existsSync(join(dir, 'objects', fp))
        ? readFileSync(join(dir, 'objects', fp))
        : null,
    write: async (fp: string, bytes: Uint8Array) => {
      writeFileSync(join(dir, 'objects', fp), bytes);
    },
  };
  const host = (
    base: string,
    intent: { source: FileEntry; target: FileEntry | null; entry: FileEntry },
    apply: boolean,
  ) => {
    const from = join(base, intent.source.path);
    const to = join(base, intent.entry.path);
    const fp = (path: string) =>
      existsSync(path) ? hash(readFileSync(path)) : null;
    if (apply && fp(from) === null && fp(to) === intent.source.fingerprint)
      return;
    if (
      fp(from) !== intent.source.fingerprint ||
      fp(to) !== (intent.target?.fingerprint ?? null)
    )
      throw new Error('Files changed before rename');
    if (apply) renameSync(from, to);
  };
  const rename = async () =>
    (runtime as any).renameFileContent(
      {
        cruxId,
        expected: await runtime.fileContentHead(cruxId),
        source,
        target,
        entry: { ...source, path: target.path },
      },
      store,
      host,
    );
  const finish = () =>
    (runtime as any).finishContentProjection(
      cruxId,
      store,
      () => {
        throw new Error('Rename must not replace the whole folder');
      },
      host,
    );
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'crux-rename-'));
    folder = join(dir, 'project');
    mkdirSync(folder);
    mkdirSync(join(dir, 'objects'));
    runtime = await LocalGraphRuntime.create(join(dir, 'garden.db'));
    cruxId = await runtime.createCrux({
      slug: randomUUID(),
      authorId: randomUUID(),
      homeId: randomUUID(),
      meta: { projectFolder: folder },
    });
    const entries = ['source.txt', 'target.txt'].map((path, i) => {
      const bytes = Buffer.from(i ? 'Original destination' : 'Source content');
      writeFileSync(join(folder, path), bytes);
      return {
        put: {
          id: randomUUID(),
          path,
          fingerprint: hash(bytes),
          size: bytes.length,
          mimeType: 'text/plain',
          encoding: 'utf-8' as const,
          mode: 0o644,
          attributes: {},
        },
        bytes,
      };
    });
    source = entries[0].put;
    target = entries[1].put;
    await runtime.editFileContent(
      { cruxId, expected: null, changes: entries },
      store,
    );
    writeFileSync(join(folder, 'untracked.txt'), 'External work');
  });
  afterEach(async () => {
    await runtime.close();
    rmSync(dir, { recursive: true, force: true });
  });
  it('replaces only the approved destination, retains safety history and survives restart', async () => {
    const before = await runtime.fileContentHead(cruxId);
    await rename();
    expect(readFileSync(join(folder, source.path), 'utf8')).toBe(
      'Source content',
    );
    expect(await finish()).toBe(true);
    expect(existsSync(join(folder, source.path))).toBe(false);
    expect(readFileSync(join(folder, target.path), 'utf8')).toBe(
      'Source content',
    );
    expect(readFileSync(join(folder, 'untracked.txt'), 'utf8')).toBe(
      'External work',
    );
    const safety = (await runtime.listEditHistory(cruxId)).checkpoints.find(
      (x) => x.reason === 'safety',
    );
    expect(safety?.root).toBe(before!.root);
    await runtime.close();
    runtime = await LocalGraphRuntime.open(join(dir, 'garden.db'));
    expect(await finish()).toBe(false);
    const tree = new FileManifest(store);
    expect(
      (await tree.entries((await runtime.fileContentHead(cruxId))!.root)).map(
        (x) => x.path,
      ),
    ).toEqual(['target.txt']);
    expect(
      Buffer.from(
        (await tree.readFile(safety!.root, 'target.txt'))!.bytes,
      ).toString(),
    ).toBe('Original destination');
  });
  it('refuses changed disk bytes and a native commit failure before touching either file', async () => {
    const before = await runtime.fileContentHead(cruxId);
    writeFileSync(join(folder, target.path), 'External destination edit');
    await expect(rename()).rejects.toThrow(/changed/);
    expect(await runtime.fileContentHead(cruxId)).toEqual(before);
    writeFileSync(join(folder, target.path), 'Original destination');
    await runtime.run(
      "CREATE TRIGGER refuse_rename BEFORE UPDATE ON file_content_heads BEGIN SELECT RAISE(ABORT, 'Storage refused'); END",
    );
    await expect(rename()).rejects.toThrow(/Storage refused/);
    expect(readFileSync(join(folder, source.path), 'utf8')).toBe(
      'Source content',
    );
    expect(readFileSync(join(folder, target.path), 'utf8')).toBe(
      'Original destination',
    );
    expect(await runtime.fileContentHead(cruxId)).toEqual(before);
    await runtime.run('DROP TRIGGER refuse_rename');
    await rename();
    await finish();
  });
  it('replays a completed disk rename after completion recording fails and fences intervening edits', async () => {
    await rename();
    await runtime.run(
      "CREATE TRIGGER refuse_finish BEFORE DELETE ON settings BEGIN SELECT RAISE(ABORT, 'Completion refused'); END",
    );
    await expect(finish()).rejects.toThrow(/Completion refused/);
    expect(readFileSync(join(folder, target.path), 'utf8')).toBe(
      'Source content',
    );
    await expect(
      runtime.editFileContent(
        {
          cruxId,
          expected: await runtime.fileContentHead(cruxId),
          changes: [{ remove: target.path }],
        },
        store,
      ),
    ).rejects.toThrow(/pending/);
    await runtime.run('DROP TRIGGER refuse_finish');
    await runtime.close();
    runtime = await LocalGraphRuntime.open(join(dir, 'garden.db'));
    expect(await finish()).toBe(true);
    expect(readFileSync(join(folder, 'untracked.txt'), 'utf8')).toBe(
      'External work',
    );
  });
  it('refuses stale source/destination identities and captures caller input before yielding', async () => {
    const expected = (await runtime.fileContentHead(cruxId))!;
    const input = {
      cruxId,
      expected,
      source,
      target,
      entry: { ...source, path: target.path },
    };
    await expect(
      (runtime as any).renameFileContent(
        { ...input, target: { ...target, id: 'different' } },
        store,
        host,
      ),
    ).rejects.toThrow(/changed/);
    const pending = (runtime as any).renameFileContent(input, store, host);
    input.entry.path = 'redirected.txt';
    input.target = {
      ...target,
      fingerprint: hash(Buffer.from('Caller mutation')),
    };
    await pending;
    await finish();
    expect(readFileSync(join(folder, 'target.txt'), 'utf8')).toBe(
      'Source content',
    );
    expect(existsSync(join(folder, 'redirected.txt'))).toBe(false);
  });
  it('retains a distinct safety root for rapid consecutive renames', async () => {
    await rename();
    await finish();
    const head = (await runtime.fileContentHead(cruxId))!;
    const current = (await new FileManifest(store).get(
      head.root,
      'target.txt',
    ))!;
    await (runtime as any).renameFileContent(
      {
        cruxId,
        expected: head,
        source: current,
        target: null,
        entry: { ...current, path: 'next.txt' },
      },
      store,
      host,
    );
    await finish();
    expect(
      (await runtime.listEditHistory(cruxId)).checkpoints.filter(
        (x) => x.reason === 'safety',
      ),
    ).toHaveLength(2);
    expect(readFileSync(join(folder, 'next.txt'), 'utf8')).toBe(
      'Source content',
    );
  });
});
