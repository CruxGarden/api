import { createHash, randomUUID } from 'crypto';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { LocalGraphRuntime } from './graph-runtime';
import { inspectDesktopManifestRecovery } from './desktop-recovery';
import type { DesktopContentStore } from './desktop-content';

describe('Garden Mood dependency transfer', () => {
  let scratch: string;
  let source: LocalGraphRuntime;
  let target: LocalGraphRuntime;
  let store: DesktopContentStore;
  let objects: Map<string, Uint8Array>;
  const attribution = { authorId: randomUUID(), homeId: randomUUID() };
  beforeEach(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'garden-mood-transfer-'));
    source = await LocalGraphRuntime.create(join(scratch, 'source.db'));
    target = await LocalGraphRuntime.create(join(scratch, 'target.db'));
    objects = new Map();
    store = {
      read: async (id) => objects.get(id) ?? null,
      write: async (id, bytes) => {
        objects.set(id, Uint8Array.from(bytes));
      },
    };
  });
  afterEach(async () => {
    await source.close();
    await target.close();
    rmSync(scratch, { recursive: true, force: true });
  });
  const node = (
    runtime: LocalGraphRuntime,
    kind: 'garden' | 'mood',
    meta = {},
  ) => runtime.createCrux({ ...attribution, slug: randomUUID(), kind, meta });
  const select = async (
    runtime: LocalGraphRuntime,
    gardenId: string,
    moodId: string | null,
  ) =>
    runtime.selectGardenMood({
      ...attribution,
      gardenId,
      moodId,
      mode: moodId ? 'own' : 'inherit',
      expected: (await runtime.readGardenMood(gardenId)).selection,
    });
  async function fixture() {
    const garden = await node(source, 'garden'),
      child = await node(source, 'garden'),
      mood = await node(source, 'mood');
    await source.addGardenMember({
      ...attribution,
      gardenId: garden,
      memberId: child,
    });
    await select(source, garden, mood);
    const bytes = Uint8Array.from([0, 1, 255, 32, 10]);
    await source.editFileContent(
      {
        cruxId: mood,
        expected: null,
        changes: [
          {
            put: {
              id: randomUUID(),
              path: 'mood.cruxmood',
              fingerprint: createHash('sha256').update(bytes).digest('hex'),
              size: bytes.length,
              encoding: 'binary',
              mimeType: 'application/zip',
              mode: 0o644,
              attributes: {},
            },
            bytes,
          },
        ],
      },
      store,
    );
    return { garden, child, mood, bytes };
  }
  it('captures a selected Mood with its bytes without making it a member, then copies and resolves it', async () => {
    const f = await fixture();
    const graph = await source.exportPrivateGraph(
      { roots: [f.garden], includeMembers: true },
      store,
    );
    expect(graph.selection.roots).toEqual([f.garden]);
    expect(graph.cruxes.map((n) => n.id)).toEqual(
      expect.arrayContaining([f.garden, f.child, f.mood]),
    );
    expect(graph.boundary).toEqual([]);
    const imported = await target.importPrivateGraph(
      {
        requestId: randomUUID(),
        mode: 'copy',
        destination: attribution,
        graph,
      },
      store,
      store,
    );
    expect(await target.resolveGardenMood(imported.ids[f.child])).toMatchObject(
      { moodId: imported.ids[f.mood], sourceGardenId: imported.ids[f.garden] },
    );
    expect(
      (await target.listGardenMembers(imported.ids[f.garden])).items.map(
        (n) => n.id,
      ),
    ).toEqual([imported.ids[f.child]]);
    const file = await target.readFileContent(
      {
        cruxId: imported.ids[f.mood],
        expected: await target.fileContentHead(imported.ids[f.mood]),
        path: 'mood.cruxmood',
      },
      store,
    );
    expect(file?.bytes).toEqual(f.bytes);
  });
  it('keeps inherit relative when a child is copied under a new parent without exporting its former parent', async () => {
    const f = await fixture();
    const garden = await node(target, 'garden'),
      mood = await node(target, 'mood');
    await select(target, garden, mood);
    const graph = await source.exportPrivateGraph(
      { roots: [f.child], includeMembers: true },
      store,
    );
    expect(graph.cruxes.map((n) => n.id)).toEqual([f.child]);
    const imported = await target.importPrivateGraph(
      {
        requestId: randomUUID(),
        mode: 'copy',
        destination: attribution,
        gardenId: garden,
        graph,
      },
      store,
      store,
    );
    expect(await target.resolveGardenMood(imported.ids[f.child])).toMatchObject(
      { moodId: mood, sourceGardenId: garden },
    );
  });
  it.each(['missing link', 'missing target', 'wrong kind', 'duplicate link'])(
    'refuses %s before staging a private import',
    async (failure) => {
      const f = await fixture();
      const graph = await source.exportPrivateGraph(
        { roots: [f.garden, f.mood], includeMembers: true },
        store,
      );
      const link = graph.dimensions.find((e) => e.kind === 'mood')!;
      if (failure === 'missing link')
        graph.dimensions = graph.dimensions.filter((e) => e.id !== link.id);
      if (failure === 'missing target') {
        graph.cruxes = graph.cruxes.filter((n) => n.id !== f.mood);
        graph.dimensions = graph.dimensions.filter((e) => e.id !== link.id);
        graph.contentHeads = graph.contentHeads.filter(
          (h) => h.cruxId !== f.mood,
        );
        graph.selection.roots = [f.garden];
      }
      if (failure === 'wrong kind')
        graph.cruxes.find((n) => n.id === f.mood)!.kind = 'document';
      if (failure === 'duplicate link')
        graph.dimensions.push({ ...link, id: randomUUID() });
      let writes = 0;
      await expect(
        target.importPrivateGraph(
          {
            requestId: randomUUID(),
            mode: 'copy',
            destination: attribution,
            graph,
          },
          store,
          {
            ...store,
            write: async () => {
              writes++;
            },
          },
        ),
      ).rejects.toThrow(/Mood/);
      expect(writes).toBe(0);
      expect(await target.all('SELECT id FROM cruxes')).toEqual([]);
    },
  );
  it('refuses broken selection in a full recovery image', async () => {
    const f = await fixture();
    await source.run(
      "UPDATE dimensions SET deleted = ? WHERE source_id = ? AND kind = 'mood'",
      ['2026-09-24', f.garden],
    );
    await expect(
      inspectDesktopManifestRecovery(await source.exportDatabase(), store),
    ).rejects.toThrow(/Mood/);
  });
  it('protects a selected Mood until its retained Garden changes selection, even after the Garden is trashed', async () => {
    const f = await fixture();
    await expect(source.setCruxTrashed(f.mood, true)).rejects.toThrow(/Mood/);
    await expect(source.deleteCrux(f.mood)).rejects.toThrow(/Mood/);
    await source.setCruxTrashed(f.garden, true);
    await expect(source.deleteCrux(f.mood)).rejects.toThrow(/Mood/);
    await source.setCruxTrashed(f.garden, false);
    await select(source, f.garden, null);
    await source.deleteCrux(f.mood);
    expect(await source.resolveGardenMood(f.child)).toMatchObject({
      mode: 'default',
    });
  });
});
