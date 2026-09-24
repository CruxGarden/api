import { inspectDesktopManifestRecovery } from './desktop-recovery';
import JSZip = require('jszip');
import {
  packPrivateGraph,
  openPrivateGraphArchive,
} from './private-graph-archive';
import { createHash, randomUUID } from 'crypto';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { LocalGraphRuntime } from './graph-runtime';
import { CruxKind, DimensionType } from '../common/types/enums';
import type { DesktopContentStore } from './desktop-content';
import type { PrivateGraphImport } from './portable-graph';

const hash = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
const contentStore = (
  objects: Map<string, Uint8Array>,
): DesktopContentStore => ({
  read: async (id) => objects.get(id) ?? null,
  write: async (id, bytes) => {
    objects.set(id, Uint8Array.from(bytes));
  },
});

describe('private selected graph transfer through the API owner', () => {
  let dir: string;
  let source: LocalGraphRuntime;
  let target: LocalGraphRuntime;
  let incoming: DesktopContentStore;
  let destination: DesktopContentStore;
  let objects: Map<string, Uint8Array>;
  let targetObjects: Map<string, Uint8Array>;
  const sourceIdentity = { authorId: randomUUID(), homeId: randomUUID() };
  const targetIdentity = { authorId: randomUUID(), homeId: randomUUID() };
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'private-graph-'));
    source = await LocalGraphRuntime.create(join(dir, 'source.db'));
    target = await LocalGraphRuntime.create(join(dir, 'target.db'));
    objects = new Map();
    targetObjects = new Map();
    incoming = contentStore(objects);
    destination = contentStore(targetObjects);
  });
  afterEach(async () => {
    await source.close();
    await target.close();
    rmSync(dir, { recursive: true, force: true });
  });
  async function fixture() {
    const garden = await source.createCrux({
      ...sourceIdentity,
      slug: 'garden',
      kind: CruxKind.GARDEN,
      meta: {
        mood: { synth: { tracks: [{ brightness: 0.3 }] } },
        layout: { panels: ['artifacts'] },
      },
    });
    const child = await source.createCrux({
      ...sourceIdentity,
      slug: 'child',
      kind: CruxKind.GARDEN,
    });
    const work = await source.createCrux({
      ...sourceIdentity,
      slug: 'work',
      meta: {
        projectFolder: '/private/source/work',
        turnJob: { secret: 'active turn' },
        agentHost: true,
        settings: {
          agentSessionId: 'private session',
          agentSessions: { codex: 'resume token' },
          previewPort: 4231,
          palette: { accent: '#123456' },
        },
        messages: [{ role: 'user', content: garden }],
        opaque: { cruxId: garden },
      },
    });
    const outside = await source.createCrux({
      ...sourceIdentity,
      slug: 'outside',
      meta: { secret: 'private sibling' },
    });
    for (const [gardenId, memberId] of [
      [garden, child],
      [garden, work],
      [child, work],
    ])
      await source.execute(({ garden: service }) =>
        service.add({ ...sourceIdentity, gardenId, memberId }),
      );
    await source.execute(({ dimension }) =>
      dimension.create({
        ...sourceIdentity,
        sourceId: work,
        targetId: outside,
        type: DimensionType.GRAFT,
        meta: { secret: 'private boundary note' },
      }),
    );
    const bytes = Uint8Array.from([0, 255, 16, 32]);
    const fingerprint = hash(bytes);
    const file = {
      id: 'stable-file',
      path: 'nested/file.bin',
      fingerprint,
      size: bytes.length,
      mode: 0o640,
      mimeType: 'application/octet-stream',
      encoding: 'binary',
      attributes: { keep: true },
    };
    const head = await source.editFileContent(
      { cruxId: work, expected: null, changes: [{ put: file, bytes }] },
      incoming,
    );
    const growth = await source.createGrowthSnapshot(
      {
        cruxId: work,
        expected: head,
        snapshotId: randomUUID(),
        parentId: null,
        meta: { messages: [{ role: 'assistant', content: 'Saved history' }] },
      },
      incoming,
    );
    const task = randomUUID();
    await source.createWorkingCopy({
      id: task,
      taskId: randomUUID(),
      cruxId: work,
      title: 'Task',
      baseSnapshotId: growth.snapshot.id,
      role: 'task',
      meta: { settings: { activeBranch: growth.snapshot.id } },
    });
    const taskGrowth = await source.createGrowthSnapshot(
      {
        cruxId: task,
        expected: (await source.fileContentHead(task))!,
        snapshotId: randomUUID(),
        parentId: growth.snapshot.id,
      },
      incoming,
    );
    const review = randomUUID();
    await source.createWorkingCopy({
      id: review,
      taskId: randomUUID(),
      cruxId: work,
      title: 'Review',
      baseSnapshotId: growth.snapshot.id,
      role: 'review',
      meta: {},
    });
    const merge = randomUUID();
    const data = {
      id: merge,
      cruxId: work,
      copyId: task,
      candidateId: review,
      phase: 'review',
      sourceHead: taskGrowth.snapshot.id,
      targetHead: growth.snapshot.id,
      base: {},
      main: {},
      task: {},
      manifest: {},
      conflicts: [],
      resolutions: {},
      previewUrl: 'http://localhost:4000',
      verifiedKey: 'not transferable',
      custom: { preserve: true },
    };
    const date = new Date().toISOString();
    await source.run(
      'INSERT INTO task_merges (id, crux_id, copy_id, candidate_id, phase, data, created) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [merge, work, task, review, 'review', JSON.stringify(data), date],
    );
    const laterBytes = new TextEncoder().encode('Main changed');
    await source.editFileContent(
      {
        cruxId: work,
        expected: head,
        changes: [
          {
            put: {
              ...file,
              fingerprint: hash(laterBytes),
              size: laterBytes.length,
            },
            bytes: laterBytes,
          },
        ],
      },
      incoming,
    );
    await source.run(
      'INSERT INTO store (id, crux_id, visitor_id, key, value, mode, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [
        randomUUID(),
        task,
        sourceIdentity.authorId,
        'private',
        JSON.stringify({ cruxId: work }),
        'protected',
        date,
        date,
      ],
    );
    const graph = await source.exportPrivateGraph(
      { roots: [garden], includeMembers: true },
      incoming,
    );
    const request: PrivateGraphImport = {
      requestId: randomUUID(),
      mode: 'copy',
      destination: targetIdentity,
      graph,
    };
    return {
      request,
      garden,
      child,
      work,
      outside,
      task,
      review,
      merge,
      growth: growth.snapshot.id,
      taskGrowth: taskGrowth.snapshot.id,
      bytes,
      fingerprint,
      laterBytes,
    };
  }
  async function emptyTarget() {
    for (const table of [
      'cruxes',
      'working_copies',
      'task_merges',
      'dimensions',
      'store',
      'file_content_heads',
      'settings',
    ])
      expect(await target.all(`SELECT * FROM ${table}`)).toEqual([]);
  }

  it('copies shared Gardens, Main/Task/Growth and opaque bytes; excludes device state and leaves outside edges unresolved', async () => {
    const f = await fixture();
    const json = JSON.stringify(f.request.graph);
    for (const privateValue of [
      '/private/source',
      'private session',
      'resume token',
      'active turn',
      'private sibling',
      'private boundary note',
      'http://localhost',
      'not transferable',
    ])
      expect(json).not.toContain(privateValue);
    // Matching external ID at the destination is not permission to reconnect.
    await target.run(
      'INSERT INTO cruxes (id, slug, author_id, home_id, created, updated) VALUES (?, ?, ?, ?, ?, ?)',
      [
        f.outside,
        'unrelated',
        targetIdentity.authorId,
        targetIdentity.homeId,
        new Date().toISOString(),
        new Date().toISOString(),
      ],
    );
    const result = await target.importPrivateGraph(
      f.request,
      incoming,
      destination,
    );
    const id = (sourceId: string) => result.ids[sourceId];
    expect(result.roots).toEqual([id(f.garden)]);
    expect(
      Object.entries(result.ids).every(([old, next]) => old !== next),
    ).toBe(true);
    const captured = await target.exportPrivateGraph(
      { roots: result.roots, includeMembers: true },
      destination,
    );
    expect(captured.cruxes).toHaveLength(5);
    expect(
      captured.dimensions.filter((edge) => edge.targetId === id(f.work)),
    ).toHaveLength(2);
    expect(captured.boundary).toEqual(result.boundary);
    expect(captured.boundary[0].targetId).toBe(f.outside);
    const work = captured.cruxes.find((row) => row.id === id(f.work))!;
    expect(work.meta.messages).toEqual([{ role: 'user', content: f.garden }]);
    expect(work.meta.opaque).toEqual({ cruxId: f.garden });
    expect(work.meta.transferOrigin).toEqual({
      cruxId: f.work,
      authorId: sourceIdentity.authorId,
      homeId: sourceIdentity.homeId,
    });
    expect(work.authorId).toBe(targetIdentity.authorId);
    expect(
      captured.cruxes.find((row) => row.id === id(f.garden))!.meta,
    ).toMatchObject({
      mood: { synth: { tracks: [{ brightness: 0.3 }] } },
      layout: { panels: ['artifacts'] },
    });
    expect(captured.store[0].value).toBe(JSON.stringify({ cruxId: f.work }));
    expect(captured.store[0].visitorId).toBe(sourceIdentity.authorId);
    expect(
      captured.workingCopies.find((row) => row.id === id(f.task))!.meta,
    ).toEqual({ settings: { activeBranch: id(f.growth) } });
    expect(captured.taskMerges[0].data).toMatchObject({
      id: id(f.merge),
      cruxId: id(f.work),
      copyId: id(f.task),
      candidateId: id(f.review),
      sourceHead: id(f.taskGrowth),
      targetHead: id(f.growth),
      custom: { preserve: true },
    });
    for (const [owner, bytes] of [
      [f.work, f.laterBytes],
      [f.growth, f.bytes],
      [f.task, f.bytes],
    ] as const) {
      const file = await target.readFileContent(
        {
          cruxId: id(owner),
          expected: (await target.fileContentHead(id(owner)))!,
          path: 'nested/file.bin',
        },
        destination,
      );
      expect(file!.bytes).toEqual(bytes);
      expect(file!.entry).toMatchObject({
        id: 'stable-file',
        mode: 0o640,
        attributes: { keep: true },
      });
    }
    expect(await target.all('SELECT * FROM artifacts')).toEqual([]);
    expect(
      await target.all('SELECT * FROM dimensions WHERE target_id = ?', [
        f.outside,
      ]),
    ).toEqual([]);
    await target.close();
    target = await LocalGraphRuntime.open(join(dir, 'target.db'));
    expect(
      await target.exportPrivateGraph(
        { roots: result.roots, includeMembers: true },
        destination,
      ),
    ).toEqual(captured);
    expect(
      await target.importPrivateGraph(f.request, incoming, destination),
    ).toEqual(result);
  });

  it('restores identity only into an available destination and refuses collision without overwriting', async () => {
    const f = await fixture();
    f.request.mode = 'restore';
    const result = await target.importPrivateGraph(
      f.request,
      incoming,
      destination,
    );
    expect(result.roots).toEqual([f.garden]);
    const before = await target.captureSelectedGraph(
      { roots: result.roots, includeMembers: true },
      destination,
    );
    await expect(
      target.importPrivateGraph(
        { ...f.request, requestId: randomUUID() },
        incoming,
        destination,
      ),
    ).rejects.toThrow('already exists');
    expect(
      await target.captureSelectedGraph(
        { roots: result.roots, includeMembers: true },
        destination,
      ),
    ).toEqual(before);
    await target.updateCrux(f.work, { title: 'Edited after import' });
    expect(
      await target.importPrivateGraph(f.request, incoming, destination),
    ).toEqual(result);
    expect(
      (await target.get('SELECT title FROM cruxes WHERE id = ?', [f.work]))!
        .title,
    ).toBe('Edited after import');
    await expect(
      target.importPrivateGraph(
        { ...f.request, mode: 'copy' },
        incoming,
        destination,
      ),
    ).rejects.toThrow('different data');
  });

  it.each(['missing', 'corrupt'])(
    'refuses %s incoming historical bytes even if cached at destination, then retries',
    async (fault) => {
      const f = await fixture();
      const saved = objects.get(f.fingerprint)!;
      for (const [fp, bytes] of objects) targetObjects.set(fp, bytes);
      if (fault === 'missing') objects.delete(f.fingerprint);
      else objects.set(f.fingerprint, Uint8Array.of(33));
      const notices: unknown[] = [];
      target.onChange((change) => {
        notices.push(change);
      });
      await expect(
        target.importPrivateGraph(f.request, incoming, destination),
      ).rejects.toThrow();
      await emptyTarget();
      expect(notices).toEqual([]);
      objects.set(f.fingerprint, saved);
      const result = await target.importPrivateGraph(
        f.request,
        incoming,
        destination,
      );
      expect(result.roots).toHaveLength(1);
      expect(notices).toHaveLength(1);
    },
  );

  it('rolls back late ignored inserts, keeps staged content harmless, and succeeds after restart/retry', async () => {
    const f = await fixture();
    await target.run(
      "CREATE TRIGGER refuse_receipt BEFORE INSERT ON settings WHEN NEW.key LIKE 'cruxgarden:graph-import:%' BEGIN SELECT RAISE(IGNORE); END",
    );
    await expect(
      target.importPrivateGraph(f.request, incoming, destination),
    ).rejects.toThrow('receipt did not persist');
    await emptyTarget();
    expect(targetObjects.size).toBeGreaterThan(0);
    await target.run('DROP TRIGGER refuse_receipt');
    await target.close();
    target = await LocalGraphRuntime.open(join(dir, 'target.db'));
    await expect(
      target.importPrivateGraph(f.request, incoming, destination),
    ).resolves.toMatchObject({ roots: [expect.any(String)] });
  });

  it('rolls back altered prior rows and lost destination writes', async () => {
    const f = await fixture();
    await target.run(
      "CREATE TRIGGER alter_previous AFTER INSERT ON dimensions BEGIN UPDATE cruxes SET title = 'altered'; END",
    );
    await expect(
      target.importPrivateGraph(f.request, incoming, destination),
    ).rejects.toThrow('changed during admission');
    await emptyTarget();
    await target.run('DROP TRIGGER alter_previous');
    await expect(
      target.importPrivateGraph(f.request, incoming, {
        ...destination,
        write: async () => {},
      }),
    ).rejects.toThrow('did not persist');
    await emptyTarget();
    await expect(
      target.importPrivateGraph(f.request, incoming, destination),
    ).resolves.toBeDefined();
  });

  it('refuses unsupported versions, injected columns/session state, orphan records and invalid graph references', async () => {
    const f = await fixture();
    const attempts: Array<(request: any) => void> = [
      (r) => {
        r.graph.graphVersion = 2;
      },
      (r) => {
        r.graph.payloadVersion = 2;
      },
      (r) => {
        r.graph.purpose = 'publish';
      },
      (r) => {
        r.graph.cruxes[0].remoteId = 'host identity';
      },
      (r) => {
        r.graph.cruxes[0].meta.projectFolder = '/destination/private';
      },
      (r) => {
        r.graph.cruxes[0].meta.settings = {
          agentSessions: { codex: 'run this' },
        };
      },
      (r) => {
        r.graph.taskMerges[0].data.verifiedKey = 'skip checks';
      },
      (r) => {
        r.graph.cruxes.push({
          ...r.graph.cruxes[0],
          id: randomUUID(),
          slug: 'orphan',
        });
      },
      (r) => {
        r.graph.dimensions[0].targetId = randomUUID();
      },
      (r) => {
        r.graph.store[0].cruxId = randomUUID();
      },
      (r) => {
        r.graph.workingCopies[0].baseSnapshotId = randomUUID();
      },
      (r) => {
        r.graph.fingerprints.push('a'.repeat(64));
      },
    ];
    for (const change of attempts) {
      const request = structuredClone(f.request);
      change(request);
      await expect(
        target.importPrivateGraph(request, incoming, destination),
      ).rejects.toThrow();
      await emptyTarget();
    }
  });

  it('round-trips a real private archive, validates container/graph versions and refuses missing or added entries', async () => {
    const f = await fixture();
    const bytes = await packPrivateGraph(f.request.graph, incoming);
    const opened = await openPrivateGraphArchive(bytes);
    expect(opened.graph).toEqual(f.request.graph);
    const result = await target.importPrivateGraph(
      { ...f.request, graph: opened.graph },
      opened.content,
      destination,
    );
    expect(result.roots).toHaveLength(1);
    for (const mutate of [
      (zip: JSZip) => zip.remove(`content/${f.fingerprint}`),
      (zip: JSZip) => zip.file('credentials.json', 'not allowed'),
      (zip: JSZip) => zip.file('graph.json', '{}'),
      (zip: JSZip) =>
        zip.file('manifest.json', JSON.stringify({ archiveVersion: 2 })),
      (zip: JSZip) => zip.file('../content/escape', 'not allowed'),
    ]) {
      const zip = await JSZip.loadAsync(bytes);
      mutate(zip);
      await expect(
        openPrivateGraphArchive(
          await zip.generateAsync({ type: 'uint8array' }),
        ),
      ).rejects.toThrow();
    }
    objects.delete(f.fingerprint);
    await expect(packPrivateGraph(f.request.graph, incoming)).rejects.toThrow(
      'missing or corrupt',
    );
  });

  it('refuses internal membership cycles even when traversal is off, and foreign active branches', async () => {
    const f = await fixture();
    const cyclic = structuredClone(f.request);
    cyclic.graph.selection = {
      roots: [f.garden, f.child, f.work],
      includeMembers: false,
    };
    cyclic.graph.dimensions.push({
      ...cyclic.graph.dimensions.find((edge) => edge.type === 'garden')!,
      id: randomUUID(),
      sourceId: f.child,
      targetId: f.garden,
    });
    await expect(
      target.importPrivateGraph(cyclic, incoming, destination),
    ).rejects.toThrow('cycle');
    await emptyTarget();
    const branch = structuredClone(f.request);
    branch.graph.cruxes.find((row) => row.id === f.work)!.meta.settings = {
      activeBranch: f.taskGrowth,
    };
    await expect(
      target.importPrivateGraph(branch, incoming, destination),
    ).rejects.toThrow('branch');
    await emptyTarget();
  });

  it('checks all staged destination objects again before committing', async () => {
    const f = await fixture();
    let previous: string | undefined;
    await expect(
      target.importPrivateGraph(f.request, incoming, {
        read: destination.read,
        write: async (fp, bytes) => {
          if (previous) targetObjects.delete(previous);
          previous = fp;
          await destination.write(fp, bytes);
        },
      }),
    ).rejects.toThrow('Missing content');
    await emptyTarget();
    await expect(
      target.importPrivateGraph(f.request, incoming, destination),
    ).resolves.toBeDefined();
  });

  it('binds only fresh verified workspace folders, marks active Tasks ready, and never creates a folder for Growth', async () => {
    const f = await fixture();
    const calls: Array<{ id: string; role: string; files: string[] }> = [];
    const prepare = async (
      workspace: import('./import-workspace').PrepareImportedWorkspace extends (
        input: infer T,
      ) => unknown
        ? T
        : never,
    ) => {
      calls.push({
        id: workspace.id,
        role: workspace.role,
        files: workspace.files.map((file) => file.path),
      });
      if (workspace.head)
        expect(targetObjects.has(workspace.head.root)).toBe(true);
      return join(dir, workspace.id);
    };
    const result = await target.importPrivateGraph(
      f.request,
      incoming,
      destination,
      prepare,
    );
    expect(calls).toHaveLength(5);
    expect(calls.map((call) => call.id)).not.toContain(result.ids[f.growth]);
    expect(calls.map((call) => call.id)).not.toContain(
      result.ids[f.taskGrowth],
    );
    expect(calls.find((call) => call.id === result.ids[f.task])).toMatchObject({
      role: 'task',
      files: ['nested/file.bin'],
    });
    const work = await target.get('SELECT meta FROM cruxes WHERE id = ?', [
      result.ids[f.work],
    ]);
    expect(JSON.parse(work!.meta as string).projectFolder).toBe(
      join(dir, result.ids[f.work]),
    );
    const task = await target.get(
      'SELECT project_folder, phase FROM working_copies WHERE id = ?',
      [result.ids[f.task]],
    );
    expect(task).toEqual({
      project_folder: join(dir, result.ids[f.task]),
      phase: 'ready',
    });
    expect(
      await target.importPrivateGraph(
        f.request,
        incoming,
        destination,
        prepare,
      ),
    ).toEqual(result);
    expect(calls).toHaveLength(5);
    await expect(
      target.importPrivateGraph(f.request, incoming, destination),
    ).rejects.toThrow('different data');
  });

  it('rolls back folder preparation/refused binding and retries without deleting host-prepared files', async () => {
    const f = await fixture();
    const prepared: string[] = [];
    await expect(
      target.importPrivateGraph(
        f.request,
        incoming,
        destination,
        async (workspace) => {
          prepared.push(workspace.id);
          if (prepared.length === 2)
            throw new Error('Host materialization refused');
          return join(dir, workspace.id);
        },
      ),
    ).rejects.toThrow('Host materialization refused');
    expect(prepared).toHaveLength(2);
    await emptyTarget();
    await target.run(
      'CREATE TRIGGER refuse_folder BEFORE UPDATE ON cruxes BEGIN SELECT RAISE(IGNORE); END',
    );
    await expect(
      target.importPrivateGraph(
        f.request,
        incoming,
        destination,
        async (workspace) => join(dir, workspace.id),
      ),
    ).rejects.toThrow('folder');
    await emptyTarget();
    await target.run('DROP TRIGGER refuse_folder');
    await expect(
      target.importPrivateGraph(
        f.request,
        incoming,
        destination,
        async (workspace) => join(dir, workspace.id),
      ),
    ).resolves.toBeDefined();
  });

  it('refuses aliased or non-absolute returned folder bindings', async () => {
    const f = await fixture();
    await expect(
      target.importPrivateGraph(
        f.request,
        incoming,
        destination,
        async () => 'relative',
      ),
    ).rejects.toThrow('folder');
    await emptyTarget();
    await expect(
      target.importPrivateGraph(f.request, incoming, destination, async () =>
        join(dir, 'shared'),
      ),
    ).rejects.toThrow('folder');
    await emptyTarget();
  });

  it('replaces only a captured selection, keeps external root links, invalidates stale file handles and retains a recoverable safety archive', async () => {
    const f = await fixture();
    const initial = await target.importPrivateGraph(
      { ...f.request, mode: 'restore' },
      incoming,
      destination,
    );
    const before = await target.captureSelectedGraph(
      {
        roots: f.request.graph.selection.roots!,
        includeMembers: f.request.graph.selection.includeMembers!,
      },
      destination,
    );
    const outsider = await target.createCrux({
      ...targetIdentity,
      slug: 'local-connection',
      kind: CruxKind.GARDEN,
    });
    await target.execute(({ dimension }) =>
      dimension.create({
        ...targetIdentity,
        sourceId: outsider,
        targetId: f.garden,
        type: DimensionType.GARDEN,
        kind: 'membership',
      }),
    );
    const outgoing = await target.execute(({ dimension }) =>
      dimension.create({
        ...targetIdentity,
        sourceId: f.work,
        targetId: outsider,
        type: DimensionType.GRAFT,
        meta: { privateLocal: 'retained' },
      }),
    );
    const expected = (await target.fileContentHead(f.work))!;
    await target.updateCrux(f.work, { title: 'Newer local work' });
    const replacement = {
      ...f.request,
      requestId: randomUUID(),
      mode: 'replace' as const,
      replacementToken: await target.privateGraphReplacementToken(
        {
          roots: f.request.graph.selection.roots!,
          includeMembers: f.request.graph.selection.includeMembers!,
        },
        destination,
      ),
    };
    const replaced = await target.importPrivateGraph(
      replacement,
      incoming,
      destination,
    );
    expect(replaced.roots).toEqual(initial.roots);
    expect(
      (await target.get('SELECT title FROM cruxes WHERE id = ?', [f.work]))!
        .title,
    ).toBe('');
    expect(
      await target.get('SELECT id FROM cruxes WHERE id = ?', [outsider]),
    ).toBeDefined();
    expect(
      await target.get('SELECT id FROM dimensions WHERE id = ?', [outgoing.id]),
    ).toBeDefined();
    expect(
      await target.all(
        'SELECT id FROM dimensions WHERE source_id = ? AND target_id = ?',
        [outsider, f.garden],
      ),
    ).toHaveLength(1);
    await expect(
      target.readFileContent(
        { cruxId: f.work, expected, path: 'nested/file.bin' },
        destination,
      ),
    ).rejects.toThrow();
    const archiveBytes = targetObjects.get(replaced.safetyArchive!)!;
    const safety = await openPrivateGraphArchive(archiveBytes);
    expect(safety.graph.cruxes.find((row) => row.id === f.work)!.title).toBe(
      'Newer local work',
    );
    expect(safety.graph.contentHeads).toEqual(before.contentHeads);
    const recovery = await inspectDesktopManifestRecovery(
      await target.exportDatabase(),
      destination,
    );
    expect(recovery.fingerprints).toContain(replaced.safetyArchive);
    await target.close();
    target = await LocalGraphRuntime.open(join(dir, 'target.db'));
    expect(
      await target.importPrivateGraph(
        {
          ...replacement,
          replacementToken: await target.privateGraphReplacementToken(
            {
              roots: f.request.graph.selection.roots!,
              includeMembers: f.request.graph.selection.includeMembers!,
            },
            destination,
          ),
        },
        incoming,
        destination,
      ),
    ).toEqual(replaced);
    const portable = await target.exportPrivateGraph(
      {
        roots: f.request.graph.selection.roots!,
        includeMembers: f.request.graph.selection.includeMembers!,
      },
      destination,
    );
    expect(portable.boundary.some((edge) => edge.id === outgoing.id)).toBe(
      true,
    );
    expect(portable.boundary).toHaveLength(2);
  });

  it('refuses stale replacement tokens and shared non-root members without affecting local work', async () => {
    const f = await fixture();
    await target.importPrivateGraph(
      { ...f.request, mode: 'restore' },
      incoming,
      destination,
    );
    const request = {
      ...f.request,
      mode: 'replace' as const,
      requestId: randomUUID(),
      replacementToken: await target.privateGraphReplacementToken(
        {
          roots: f.request.graph.selection.roots!,
          includeMembers: f.request.graph.selection.includeMembers!,
        },
        destination,
      ),
    };
    await target.updateCrux(f.work, { title: 'Changed after review' });
    await expect(
      target.importPrivateGraph(request, incoming, destination),
    ).rejects.toThrow('changed while preparing');
    const outsider = await target.createCrux({
      ...targetIdentity,
      slug: 'another-garden',
      kind: CruxKind.GARDEN,
    });
    await target.execute(({ garden }) =>
      garden.add({ ...targetIdentity, gardenId: outsider, memberId: f.work }),
    );
    request.replacementToken = await target.privateGraphReplacementToken(
      {
        roots: f.request.graph.selection.roots!,
        includeMembers: f.request.graph.selection.includeMembers!,
      },
      destination,
    );
    const before = await target.captureSelectedGraph(
      {
        roots: f.request.graph.selection.roots!,
        includeMembers: f.request.graph.selection.includeMembers!,
      },
      destination,
    );
    await expect(
      target.importPrivateGraph(request, incoming, destination),
    ).rejects.toThrow('shares members');
    expect(
      await target.captureSelectedGraph(
        {
          roots: f.request.graph.selection.roots!,
          includeMembers: f.request.graph.selection.includeMembers!,
        },
        destination,
      ),
    ).toEqual(before);
  });

  it('replacement failure after removal rolls back the original graph and retries safely', async () => {
    const f = await fixture();
    await target.importPrivateGraph(
      { ...f.request, mode: 'restore' },
      incoming,
      destination,
    );
    await target.updateCrux(f.work, { title: 'Keep on failure' });
    const before = await target.captureSelectedGraph(
      {
        roots: f.request.graph.selection.roots!,
        includeMembers: f.request.graph.selection.includeMembers!,
      },
      destination,
    );
    const request = {
      ...f.request,
      mode: 'replace' as const,
      requestId: randomUUID(),
      replacementToken: await target.privateGraphReplacementToken(
        {
          roots: f.request.graph.selection.roots!,
          includeMembers: f.request.graph.selection.includeMembers!,
        },
        destination,
      ),
    };
    await target.run(
      'CREATE TRIGGER reject_replacement BEFORE INSERT ON file_content_heads BEGIN SELECT RAISE(IGNORE); END',
    );
    await expect(
      target.importPrivateGraph(request, incoming, destination),
    ).rejects.toThrow('did not persist');
    expect(
      await target.captureSelectedGraph(
        {
          roots: f.request.graph.selection.roots!,
          includeMembers: f.request.graph.selection.includeMembers!,
        },
        destination,
      ),
    ).toEqual(before);
    await target.run('DROP TRIGGER reject_replacement');
    const saved = objects.get(f.fingerprint)!;
    objects.delete(f.fingerprint);
    await expect(
      target.importPrivateGraph(request, incoming, destination),
    ).rejects.toThrow('Missing content');
    expect(
      await target.captureSelectedGraph(
        {
          roots: f.request.graph.selection.roots!,
          includeMembers: f.request.graph.selection.includeMembers!,
        },
        destination,
      ),
    ).toEqual(before);
    objects.set(f.fingerprint, saved);
    await expect(
      target.importPrivateGraph(request, incoming, destination),
    ).resolves.toHaveProperty('safetyArchive');
  });

  it('captures metadata and callback bindings before waiting behind another command', async () => {
    const f = await fixture();
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = target.execute(async () => {
      await waiting;
    });
    const importPromise = target.importPrivateGraph(
      f.request,
      incoming,
      destination,
    );
    f.request.graph.cruxes.find((row) => row.id === f.work)!.title =
      'Mutated while queued';
    incoming.read = async () => null;
    destination.write = async () => {
      throw new Error('Changed writer');
    };
    release();
    await pending;
    const result = await importPromise;
    expect(
      (await target.get('SELECT title FROM cruxes WHERE id = ?', [
        result.ids[f.work],
      ]))!.title,
    ).not.toBe('Mutated while queued');
  });
});
