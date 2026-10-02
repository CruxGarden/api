import { createHash, randomUUID } from 'crypto';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { LocalGraphRuntime } from './graph-runtime';
import { FileManifest, FileEntry } from './file-manifest';

describe('native guarded write/delete projection', () => {
  let dir: string;
  let folder: string;
  let owner: LocalGraphRuntime;
  let id: string;
  let original: FileEntry;
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
  // Real files at the trusted host callback. Staging/race behavior is covered by
  // the production host's own filesystem and desktop tests.
  const host = (
    base: string,
    operation: any,
    apply: boolean,
    bytes?: Uint8Array,
  ) => {
    const entry =
      operation.kind === 'write' ? operation.entry : operation.source;
    const expected =
      operation.kind === 'write'
        ? (operation.before?.fingerprint ?? null)
        : operation.source.fingerprint;
    const path = join(base, entry.path);
    const current = existsSync(path) ? hash(readFileSync(path)) : null;
    if (current !== expected) throw new Error('Disk changed');
    if (apply) {
      if (operation.kind === 'write') {
        if (!bytes || hash(bytes) !== entry.fingerprint)
          throw new Error('Host did not receive verified bytes');
        writeFileSync(path, bytes);
      } else unlinkSync(path);
    }
  };
  const finish = () =>
    (owner as any).finishContentProjection(
      id,
      store,
      () => {
        throw new Error('Must not replace whole folder');
      },
      host,
    );
  const replacement = () => {
    const bytes = Buffer.from('Replacement');
    return {
      entry: { ...original, fingerprint: hash(bytes), size: bytes.length },
      bytes,
    };
  };
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'crux-mutate-'));
    folder = join(dir, 'project');
    mkdirSync(folder);
    mkdirSync(join(dir, 'objects'));
    owner = await LocalGraphRuntime.create(join(dir, 'garden.db'));
    id = await owner.createCrux({
      type: 'workspace',
      slug: randomUUID(),
      authorId: randomUUID(),
      homeId: randomUUID(),
      meta: { projectFolder: folder },
    });
    const bytes = Buffer.from('Original');
    original = {
      id: randomUUID(),
      path: 'work.txt',
      fingerprint: hash(bytes),
      size: bytes.length,
      mode: 0o644,
      mimeType: 'text/plain',
      encoding: 'utf-8',
      attributes: {},
    };
    await owner.editFileContent(
      { cruxId: id, expected: null, changes: [{ put: original, bytes }] },
      store,
    );
    writeFileSync(join(folder, 'work.txt'), bytes);
    writeFileSync(join(folder, 'untracked.txt'), 'Preserve unrelated');
  });
  afterEach(async () => {
    await owner.close();
    rmSync(dir, { recursive: true, force: true });
  });
  it.each(['write', 'delete'])(
    'keeps disk unchanged on refused %s, then retries and retains history after restart',
    async (kind) => {
      const before = (await owner.fileContentHead(id))!;
      const invoke = () =>
        kind === 'write'
          ? (owner as any).writeFileContent(
              {
                cruxId: id,
                expected: before,
                before: original,
                retention: 'safety',
                ...replacement(),
              },
              store,
              host,
            )
          : (owner as any).deleteFileContent(
              { cruxId: id, expected: before, file: original },
              store,
              host,
            );
      await owner.run(
        "CREATE TRIGGER refuse_mutation BEFORE UPDATE ON file_content_heads BEGIN SELECT RAISE(ABORT, 'Refused'); END",
      );
      await expect(invoke()).rejects.toThrow(/Refused/);
      expect(readFileSync(join(folder, 'work.txt'), 'utf8')).toBe('Original');
      expect(await owner.fileContentHead(id)).toEqual(before);
      await owner.run('DROP TRIGGER refuse_mutation');
      await invoke();
      expect(readFileSync(join(folder, 'work.txt'), 'utf8')).toBe('Original');
      await owner.close();
      owner = await LocalGraphRuntime.open(join(dir, 'garden.db'));
      await finish();
      expect(existsSync(join(folder, 'work.txt'))).toBe(kind === 'write');
      if (kind === 'write')
        expect(readFileSync(join(folder, 'work.txt'), 'utf8')).toBe(
          'Replacement',
        );
      expect(readFileSync(join(folder, 'untracked.txt'), 'utf8')).toBe(
        'Preserve unrelated',
      );
      const safety = (await owner.listEditHistory(id)).checkpoints.find(
        (x) => x.reason === 'safety',
      )!;
      expect(
        Buffer.from(
          (await new FileManifest(store).readFile(safety.root, 'work.txt'))!
            .bytes,
        ).toString(),
      ).toBe('Original');
    },
  );
  it.each(['write', 'delete'])(
    'refuses stale indexed and unindexed %s targets without changing any bytes',
    async (kind) => {
      const expected = (await owner.fileContentHead(id))!;
      const invoke = () =>
        kind === 'write'
          ? (owner as any).writeFileContent(
              { cruxId: id, expected, before: original, ...replacement() },
              store,
              host,
            )
          : (owner as any).deleteFileContent(
              { cruxId: id, expected, file: original },
              store,
              host,
            );
      writeFileSync(join(folder, 'work.txt'), 'External work');
      await expect(invoke()).rejects.toThrow(/changed/);
      expect(await owner.fileContentHead(id)).toEqual(expected);
      expect(readFileSync(join(folder, 'work.txt'), 'utf8')).toBe(
        'External work',
      );
      writeFileSync(join(folder, 'work.txt'), 'Original');
      const changed = replacement();
      await owner.editFileContent(
        {
          cruxId: id,
          expected,
          changes: [{ put: changed.entry, bytes: changed.bytes }],
        },
        store,
      );
      await expect(
        kind === 'write'
          ? (owner as any).writeFileContent(
              {
                cruxId: id,
                expected: await owner.fileContentHead(id),
                before: original,
                ...replacement(),
              },
              store,
              host,
            )
          : (owner as any).deleteFileContent(
              {
                cruxId: id,
                expected: await owner.fileContentHead(id),
                file: original,
              },
              store,
              host,
            ),
      ).rejects.toThrow(/changed/);
    },
  );
  it('requires explicit absence for insertion and captures declared bytes before yielding', async () => {
    const data = replacement();
    const expected = await owner.fileContentHead(id);
    await expect(
      (owner as any).writeFileContent(
        { cruxId: id, expected, before: null, ...data },
        store,
        host,
      ),
    ).rejects.toThrow(/changed/);
    const entry = { ...data.entry, id: randomUUID(), path: 'new.txt' };
    const pending = (owner as any).writeFileContent(
      { cruxId: id, expected, before: null, entry, bytes: data.bytes },
      store,
      host,
    );
    data.bytes.fill(0);
    entry.path = 'redirected.txt';
    await pending;
    await finish();
    expect(readFileSync(join(folder, 'new.txt'), 'utf8')).toBe('Replacement');
    expect(existsSync(join(folder, 'redirected.txt'))).toBe(false);
  });
  it('refuses an unindexed destination and mismatched payload before changing the native head', async () => {
    const expected = await owner.fileContentHead(id);
    const data = replacement();
    const entry = { ...data.entry, id: randomUUID(), path: 'outside.txt' };
    writeFileSync(join(folder, entry.path), 'Unindexed external bytes');
    await expect(
      (owner as any).writeFileContent(
        { cruxId: id, expected, before: null, entry, bytes: data.bytes },
        store,
        host,
      ),
    ).rejects.toThrow(/changed/);
    expect(readFileSync(join(folder, entry.path), 'utf8')).toBe(
      'Unindexed external bytes',
    );
    await expect(
      (owner as any).writeFileContent(
        {
          cruxId: id,
          expected,
          before: original,
          ...data,
          bytes: Buffer.from('Wrong'),
        },
        store,
        host,
      ),
    ).rejects.toThrow(/declared content/);
    expect(await owner.fileContentHead(id)).toEqual(expected);
    expect(
      (await owner.listEditHistory(id)).checkpoints.filter(
        (x) => x.reason === 'safety',
      ),
    ).toEqual([]);
  });
  it('keeps committed projection intent across host refusal and fences a later delete until retry', async () => {
    const expected = (await owner.fileContentHead(id))!;
    await (owner as any).writeFileContent(
      { cruxId: id, expected, before: original, ...replacement() },
      store,
      host,
    );
    await expect(
      (owner as any).finishContentProjection(
        id,
        store,
        () => {},
        () => {
          throw new Error('Host refused');
        },
      ),
    ).rejects.toThrow(/Host refused/);
    const current = (await owner.fileContentHead(id))!;
    const file = (await new FileManifest(store).get(
      current.root,
      original.path,
    ))!;
    await expect(
      (owner as any).deleteFileContent(
        { cruxId: id, expected: current, file },
        store,
        host,
      ),
    ).rejects.toThrow(/pending/);
    expect(readFileSync(join(folder, original.path), 'utf8')).toBe('Original');
    await owner.close();
    owner = await LocalGraphRuntime.open(join(dir, 'garden.db'));
    await finish();
    expect(readFileSync(join(folder, original.path), 'utf8')).toBe(
      'Replacement',
    );
    expect(await finish()).toBe(false);
  });
  it('coalesces routine writes and protects only an explicitly retained replacement', async () => {
    let now = Date.now();
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    let current = original;
    try {
      for (let save = 0; save < 24; save++) {
        const bytes = Buffer.from(`Draft ${save}`);
        const entry = {
          ...current,
          fingerprint: hash(bytes),
          size: bytes.length,
        };
        await owner.writeFileContent(
          {
            cruxId: id,
            expected: await owner.fileContentHead(id),
            before: current,
            entry,
            bytes,
          },
          store,
          host,
        );
        await finish();
        current = entry;
      }
      expect(
        (await owner.listEditHistory(id)).checkpoints.map(
          (item) => item.reason,
        ),
      ).toEqual(['autosave']);

      const bytes = Buffer.from('Explicit replacement');
      const entry = {
        ...current,
        fingerprint: hash(bytes),
        size: bytes.length,
      };
      const input = {
        cruxId: id,
        expected: await owner.fileContentHead(id),
        before: current,
        entry,
        bytes,
        retention: 'safety' as 'safety' | undefined,
      };
      const write = owner.writeFileContent(input, store, host);
      input.retention = undefined;
      await write;
      await finish();
      const checkpoint = (await owner.listEditHistory(id)).checkpoints.find(
        (item) => item.reason === 'safety',
      )!;
      expect(checkpoint).toBeDefined();
      expect(
        (await new FileManifest(store).readFile(checkpoint.root, current.path))!
          .entry,
      ).toEqual(current);
      current = entry;
      for (let save = 0; save < 25; save++) {
        now += 60_001;
        const bytes = Buffer.from(`Later ${save}`);
        const entry = {
          ...current,
          fingerprint: hash(bytes),
          size: bytes.length,
        };
        await owner.writeFileContent(
          {
            cruxId: id,
            expected: await owner.fileContentHead(id),
            before: current,
            entry,
            bytes,
          },
          store,
          host,
        );
        await finish();
        current = entry;
      }
      await owner.close();
      owner = await LocalGraphRuntime.open(join(dir, 'garden.db'));
      const history = (await owner.listEditHistory(id)).checkpoints;
      expect(history.filter((item) => item.reason === 'autosave')).toHaveLength(
        20,
      );
      expect(history.filter((item) => item.reason === 'safety')).toEqual([
        checkpoint,
      ]);
      expect(readFileSync(join(folder, 'work.txt'), 'utf8')).toBe('Later 24');
    } finally {
      jest.restoreAllMocks();
    }
  });
  it('refuses unsupported write retention before touching the head or disk', async () => {
    const expected = await owner.fileContentHead(id);
    const input = {
      cruxId: id,
      expected,
      before: original,
      ...replacement(),
      retention: 'discard' as never,
    };
    await expect(owner.writeFileContent(input, store, host)).rejects.toThrow(
      /retention/i,
    );
    expect(await owner.fileContentHead(id)).toEqual(expected);
    expect(readFileSync(join(folder, 'work.txt'), 'utf8')).toBe('Original');
    expect((await owner.listEditHistory(id)).checkpoints).toEqual([]);
  });
});
