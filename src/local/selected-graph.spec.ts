import { createHash, randomUUID } from 'crypto';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { LocalGraphRuntime } from './graph-runtime';
import type { DesktopContentStore } from './desktop-content';
import { DimensionType } from '../common/types/enums';

describe('API-owned selected graph capture', () => {
  let dir: string;
  let owner: LocalGraphRuntime;
  let objects: Map<string, Uint8Array>;
  let store: DesktopContentStore;
  let identity: { authorId: string; homeId: string };
  const hash = (bytes: Uint8Array) =>
    createHash('sha256').update(bytes).digest('hex');
  const create = (
    title: string,
    kind?: 'garden',
    meta: Record<string, unknown> = {},
  ) =>
    owner.createCrux({
      ...identity,
      slug: title.toLowerCase(),
      title,
      kind,
      meta,
    });
  const member = (gardenId: string, memberId: string) =>
    // Source capture preserves unrestricted existing graphs, independent of app placement policy.
    owner.execute(({ dimension }) =>
      dimension.create({
        ...identity,
        sourceId: gardenId,
        targetId: memberId,
        type: DimensionType.GARDEN,
        kind: 'membership',
      }),
    );
  const connect = (
    sourceId: string,
    targetId: string,
    type: DimensionType,
    kind?: string,
  ) =>
    owner.execute(({ dimension }) =>
      dimension.create({
        ...identity,
        sourceId,
        targetId,
        type,
        kind,
        meta: { privateEdgeNote: 'Not boundary metadata' },
      }),
    );
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'selected-graph-'));
    owner = await LocalGraphRuntime.create(join(dir, 'garden.db'));
    objects = new Map();
    store = {
      read: async (id) => objects.get(id) ?? null,
      write: async (id, bytes) => {
        objects.set(id, Uint8Array.from(bytes));
      },
    };
    identity = { authorId: randomUUID(), homeId: randomUUID() };
  });
  afterEach(async () => {
    await owner.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function graph() {
    const root = await create('Garden', 'garden');
    const left = await create('Left', 'garden');
    const right = await create('Right', 'garden');
    const work = await create('Shared work', undefined, {
      messages: [{ role: 'user', content: 'Keep the conversation' }],
      projectFolder: '/host-private/work',
      opaque: { value: 'a'.repeat(64) },
    });
    const outside = await create('Private sibling', undefined, {
      secret: 'Never include me',
    });
    await member(root, left);
    await member(root, right);
    await member(left, work);
    await member(right, work);
    await connect(work, outside, DimensionType.GRAFT);
    await connect(root, outside, DimensionType.GARDEN, 'derivation');
    const absent = randomUUID();
    await connect(work, absent, DimensionType.GATE);
    return { root, left, right, work, outside, absent };
  }

  async function content(id: string) {
    const bytes = Uint8Array.from([0, 1, 254, 255, 10]);
    const change = {
      put: {
        id: 'stable-file',
        path: 'data.bin',
        fingerprint: hash(bytes),
        size: bytes.length,
        encoding: 'binary',
        mimeType: 'application/octet-stream',
        mode: 0o640,
        attributes: { custom: ['Keep', 7] },
      },
      bytes,
    };
    const first = await owner.editFileContent(
      { cruxId: id, expected: null, changes: [change] },
      store,
    );
    const growth = await owner.createGrowthSnapshot(
      {
        cruxId: id,
        expected: first,
        snapshotId: randomUUID(),
        parentId: null,
        meta: {
          messages: [{ role: 'user', content: 'Historical conversation' }],
        },
      },
      store,
    );
    const taskId = randomUUID();
    await owner.createWorkingCopy(
      {
        id: taskId,
        cruxId: id,
        taskId: randomUUID(),
        title: 'Task',
        base: {
          expected: await owner.fileContentHead(id),
          expectedMeta:
            (await owner.execute(({ crux }) => crux.findById(id))).meta ?? {},
        },
        role: 'task',
        meta: {},
      },
      store,
    );
    const taskGrowth = await owner.createGrowthSnapshot(
      {
        cruxId: taskId,
        expected: (await owner.fileContentHead(taskId))!,
        snapshotId: randomUUID(),
        parentId: growth.snapshot.id,
      },
      store,
    );
    const laterBytes = new TextEncoder().encode('Current content');
    const latest = await owner.editFileContent(
      {
        cruxId: id,
        expected: first,
        changes: [
          {
            put: {
              ...change.put,
              size: laterBytes.length,
              fingerprint: hash(laterBytes),
            },
            bytes: laterBytes,
          },
        ],
      },
      store,
    );
    return { bytes, change, first, growth, taskId, taskGrowth, latest };
  }

  it('deduplicates nested membership, retains internal edges and records minimal outgoing boundaries', async () => {
    const ids = await graph();
    const selected = await owner.captureSelectedGraph(
      { roots: [ids.root, ids.left, ids.root], includeMembers: true },
      store,
    );
    expect(selected.cruxes.map((node) => node.id).sort()).toEqual(
      [ids.root, ids.left, ids.right, ids.work].sort(),
    );
    expect(selected.dimensions).toHaveLength(4);
    expect(
      selected.dimensions.filter((edge) => edge.targetId === ids.work),
    ).toHaveLength(2);
    expect(selected.boundary).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceId: ids.work,
          targetId: ids.outside,
          type: 'graft',
          state: 'outside-selection',
        }),
        expect.objectContaining({
          sourceId: ids.work,
          targetId: ids.absent,
          type: 'gate',
          state: 'unavailable',
        }),
      ]),
    );
    expect(JSON.stringify(selected)).not.toContain('Private sibling');
    expect(JSON.stringify(selected)).not.toContain('Never include me');
    expect(JSON.stringify(selected.boundary)).not.toContain('privateEdgeNote');
    expect(selected.fingerprints).toEqual([]);
  });

  it('does not traverse membership without the explicit policy or include installation/account state', async () => {
    const { root, work } = await graph();
    await content(work);
    await owner.run('INSERT INTO settings (key, value) VALUES (?, ?)', [
      'cruxgarden:private-setting',
      'Keep on this machine',
    ]);
    const selected = await owner.captureSelectedGraph(
      { roots: [root], includeMembers: false },
      store,
    );
    expect(selected.cruxes.map((node) => node.id)).toEqual([root]);
    expect(selected.dimensions).toEqual([]);
    expect(selected.contentHeads).toEqual([]);
    expect(selected.boundary).toHaveLength(3);
    expect(JSON.stringify(selected)).not.toContain('Keep on this machine');
  });

  it('retains Main, Task and Growth roots, exact records and bytes across restart without per-file rows', async () => {
    const { root, work } = await graph();
    const retained = await content(work);
    const selection = { roots: [root], includeMembers: true };
    const notices: unknown[] = [];
    owner.onChange((notice) => {
      notices.push(notice);
    });
    const selected = await owner.captureSelectedGraph(selection, store);
    expect(selected.contentHeads).toHaveLength(4);
    expect(selected.workingCopies).toMatchObject([
      {
        id: retained.taskId,
        baseState: { workspace: { parentId: retained.growth.snapshot.id } },
      },
    ]);
    expect(
      selected.cruxes.find(
        (node) => node.id === retained.taskGrowth.snapshot.id,
      )?.meta.parentCruxId,
    ).toBe(retained.growth.snapshot.id);
    expect(
      selected.cruxes.find((node) => node.id === work)?.meta,
    ).toMatchObject({
      projectFolder: '/host-private/work',
      opaque: { value: 'a'.repeat(64) },
      messages: [{ role: 'user', content: 'Keep the conversation' }],
    });
    expect(selected.fingerprints).toContain(retained.first.root);
    expect(selected.fingerprints).toContain(retained.latest.root);
    expect(selected.fingerprints).toContain(retained.change.put.fingerprint);
    expect(selected.fingerprints).not.toContain('a'.repeat(64));
    expect(notices).toEqual([]);
    expect(await owner.all('SELECT id FROM artifacts')).toEqual([]);
    await owner.close();
    owner = await LocalGraphRuntime.open(join(dir, 'garden.db'));
    expect(await owner.captureSelectedGraph(selection, store)).toEqual(
      selected,
    );
  });

  it('refuses missing historical bytes and retries without modifying the working graph', async () => {
    const work = await create('Work');
    const { change, latest } = await content(work);
    const bytes = objects.get(change.put.fingerprint)!;
    objects.delete(change.put.fingerprint);
    await expect(
      owner.captureSelectedGraph(
        { roots: [work], includeMembers: true },
        store,
      ),
    ).rejects.toThrow('Missing content');
    expect(await owner.fileContentHead(work)).toEqual(latest);
    objects.set(change.put.fingerprint, bytes);
    expect(
      (
        await owner.captureSelectedGraph(
          { roots: [work], includeMembers: true },
          store,
        )
      ).fingerprints,
    ).toContain(change.put.fingerprint);
  });

  it('includes and verifies typed portrait references without scanning arbitrary metadata', async () => {
    const bytes = Buffer.from('Portrait');
    const fingerprint = hash(bytes);
    const work = await create('Work', undefined, {
      authorSnapshots: { person: { avatarFingerprint: fingerprint } },
      arbitrary: 'b'.repeat(64),
    });
    await expect(
      owner.captureSelectedGraph(
        { roots: [work], includeMembers: false },
        store,
      ),
    ).rejects.toThrow('missing or corrupt');
    objects.set(fingerprint, bytes);
    expect(
      (
        await owner.captureSelectedGraph(
          { roots: [work], includeMembers: false },
          store,
        )
      ).fingerprints,
    ).toEqual([fingerprint]);
  });

  it('refuses selected pending projections and legacy rows but does not block on unrelated recovery', async () => {
    const work = await create('Work');
    const outside = await create('Outside');
    const request = { roots: [work], includeMembers: false };
    const prefix = 'cruxgarden:content-projection:';
    await owner.run('INSERT INTO settings (key, value) VALUES (?, ?)', [
      prefix + outside,
      '{}',
    ]);
    await expect(
      owner.captureSelectedGraph(request, store),
    ).resolves.toBeDefined();
    await owner.run('INSERT INTO settings (key, value) VALUES (?, ?)', [
      prefix + work,
      '{}',
    ]);
    await expect(owner.captureSelectedGraph(request, store)).rejects.toThrow(
      'recovery',
    );
    await owner.run('DELETE FROM settings WHERE key = ?', [prefix + work]);
    await owner.run(
      'INSERT INTO artifacts (id, resource_id, author_id, home_id, created, updated) VALUES (?, ?, ?, ?, ?, ?)',
      [
        randomUUID(),
        work,
        identity.authorId,
        identity.homeId,
        new Date().toISOString(),
        new Date().toISOString(),
      ],
    );
    await expect(owner.captureSelectedGraph(request, store)).rejects.toThrow(
      'per-file',
    );
  });

  it('refuses broken Growth ancestry and missing Task heads instead of silently omitting them', async () => {
    const work = await create('Work');
    const { growth, taskId } = await content(work);
    await owner.run(
      "UPDATE cruxes SET meta = json_set(meta, '$.parentCruxId', ?) WHERE id = ?",
      [randomUUID(), growth.snapshot.id],
    );
    await expect(
      owner.captureSelectedGraph(
        { roots: [work], includeMembers: false },
        store,
      ),
    ).rejects.toThrow('ancestry');
    await owner.run(
      "UPDATE cruxes SET meta = json_remove(meta, '$.parentCruxId') WHERE id = ?",
      [growth.snapshot.id],
    );
    await owner.run('DELETE FROM file_content_heads WHERE crux_id = ?', [
      taskId,
    ]);
    await expect(
      owner.captureSelectedGraph(
        { roots: [work], includeMembers: false },
        store,
      ),
    ).rejects.toThrow('retained content head');
  });

  it('captures selection and reader before queueing and excludes later committed edits', async () => {
    const work = await create('Work');
    await content(work);
    const outside = await create('Outside');
    let release!: () => void;
    const held = owner.execute(
      async () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    while (!release) await new Promise((resolve) => setImmediate(resolve));
    const selection = { roots: [work], includeMembers: false };
    const capturing = owner.captureSelectedGraph(selection, store);
    selection.roots[0] = outside;
    selection.includeMembers = true;
    store.read = async () => {
      throw new Error('Wrong reader');
    };
    const editing = owner.updateCrux(work, { title: 'Later edit' });
    release();
    await held;
    const captured = await capturing;
    await editing;
    expect(captured.selection).toEqual({
      roots: [work],
      includeMembers: false,
    });
    expect(captured.cruxes.find((node) => node.id === work)?.title).toBe(
      'Work',
    );
    expect(
      (
        await owner.get<{ title: string }>(
          'SELECT title FROM cruxes WHERE id = ?',
          [work],
        )
      )?.title,
    ).toBe('Later edit');
  });

  it('preserves review-only payloads and Store rows, refuses applying merges, and ignores unrelated merges', async () => {
    const work = await create('Work');
    const { taskId, growth, taskGrowth } = await content(work);
    const candidateId = randomUUID();
    await owner.createWorkingCopy(
      {
        id: candidateId,
        cruxId: work,
        taskId: randomUUID(),
        title: 'Review',
        base: {
          expected: await owner.fileContentHead(work),
          expectedMeta:
            (await owner.execute(({ crux }) => crux.findById(work))).meta ?? {},
        },
        role: 'review',
        meta: {},
      },
      store,
    );
    const bytes = Buffer.from('Resolved content, not in any current manifest');
    const fingerprint = hash(bytes);
    objects.set(fingerprint, bytes);
    const id = randomUUID();
    const data = {
      id,
      cruxId: work,
      copyId: taskId,
      candidateId,
      phase: 'review',
      sourceHead: taskGrowth.snapshot.id,
      targetHead: growth.snapshot.id,
      manifest: { 'resolved.txt': { fingerprint } },
      conflicts: [],
      verificationLog: 'Retain evidence',
    };
    await owner.run(
      'INSERT INTO task_merges (id, crux_id, copy_id, candidate_id, phase, data, created) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [
        id,
        work,
        taskId,
        candidateId,
        'review',
        JSON.stringify(data),
        new Date().toISOString(),
      ],
    );
    await owner.run(
      'INSERT INTO store (id, crux_id, visitor_id, key, value, mode, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [
        randomUUID(),
        taskId,
        identity.authorId,
        'document',
        JSON.stringify({ keep: ['private', 1] }),
        'protected',
        new Date().toISOString(),
        new Date().toISOString(),
      ],
    );
    const selection = { roots: [work], includeMembers: false };
    const capture = await owner.captureSelectedGraph(selection, store);
    expect(capture.fingerprints).toContain(fingerprint);
    expect(capture.store).toMatchObject([
      { cruxId: taskId, visitorId: identity.authorId, mode: 'protected' },
    ]);
    expect(JSON.parse(capture.taskMerges[0].data)).toEqual(data);
    objects.delete(fingerprint);
    await expect(owner.captureSelectedGraph(selection, store)).rejects.toThrow(
      'missing or corrupt',
    );
    objects.set(fingerprint, bytes);
    await owner.run("UPDATE task_merges SET phase = 'applying' WHERE id = ?", [
      id,
    ]);
    await expect(owner.captureSelectedGraph(selection, store)).rejects.toThrow(
      'Recover the selected Task merge',
    );
    const unrelated = await create('Unrelated');
    await expect(
      owner.captureSelectedGraph(
        { roots: [unrelated], includeMembers: false },
        store,
      ),
    ).resolves.toBeDefined();
  });

  it('refuses cyclic Growth and unsupported content formats', async () => {
    const work = await create('Work');
    const { growth } = await content(work);
    const request = { roots: [work], includeMembers: false };
    await owner.run(
      "UPDATE cruxes SET meta = json_set(meta, '$.parentCruxId', ?) WHERE id = ?",
      [growth.snapshot.id, growth.snapshot.id],
    );
    await expect(owner.captureSelectedGraph(request, store)).rejects.toThrow(
      'cycle',
    );
    await owner.run(
      "UPDATE cruxes SET meta = json_remove(meta, '$.parentCruxId') WHERE id = ?",
      [growth.snapshot.id],
    );
    await owner.run(
      'UPDATE file_content_heads SET format_version = 42 WHERE crux_id = ?',
      [work],
    );
    await expect(owner.captureSelectedGraph(request, store)).rejects.toThrow(
      'content head',
    );
  });

  it('refuses membership cycles introduced outside the owned command and invalid selections', async () => {
    const { root, left } = await graph();
    await connect(left, root, DimensionType.GARDEN, 'membership');
    await expect(
      owner.captureSelectedGraph(
        { roots: [root], includeMembers: true },
        store,
      ),
    ).rejects.toThrow('cycle');
    for (const selection of [
      { roots: [], includeMembers: false },
      { roots: ['bad'], includeMembers: false },
      { roots: [root] },
    ])
      await expect(
        owner.captureSelectedGraph(selection as any, store),
      ).rejects.toThrow('Select explicit');
  });
});
