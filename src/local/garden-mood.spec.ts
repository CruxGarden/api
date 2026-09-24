import { mkdtempSync, rmSync } from 'fs';
import { randomUUID } from 'crypto';
import { join } from 'path';
import { tmpdir } from 'os';
import { DimensionType } from '../common/types/enums';
import { LocalGraphRuntime } from './graph-runtime';

describe('Garden Mood graph ownership', () => {
  let scratch: string;
  let filename: string;
  let runtime: LocalGraphRuntime;
  let authorId: string;
  let homeId: string;
  beforeEach(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'garden-mood-'));
    filename = join(scratch, 'garden.db');
    runtime = await LocalGraphRuntime.create(filename);
    authorId = randomUUID();
    homeId = randomUUID();
  });
  afterEach(async () => {
    await runtime.close();
    rmSync(scratch, { recursive: true, force: true });
  });
  const node = (
    type = 'workspace',
    kind: 'garden' | 'mood' | null = 'garden',
  ) => runtime.createCrux({ slug: randomUUID(), type, kind, authorId, homeId });
  const attach = (gardenId: string, memberId: string) =>
    runtime.addGardenMember({ gardenId, memberId, authorId, homeId });
  const read = (id: string) => runtime.readGardenMood(id);
  const choose = async (
    gardenId: string,
    moodId: string | null,
    mode: 'own' | 'inherit' | 'none' = moodId ? 'own' : 'inherit',
  ) =>
    runtime.selectGardenMood({
      gardenId,
      moodId,
      mode,
      expected: (await read(gardenId)).selection,
      authorId,
      homeId,
    });

  it('inherits from structural ancestry, stops at none, resets and survives restart', async () => {
    const root = await node(),
      child = await node(),
      leaf = await node(),
      mood = await node('workspace', 'mood');
    await attach(root, child);
    await attach(child, leaf);
    expect(await runtime.resolveGardenMood(leaf)).toMatchObject({
      moodId: null,
      sourceGardenId: null,
      mode: 'default',
    });
    await choose(root, mood);
    expect(await runtime.resolveGardenMood(leaf)).toMatchObject({
      moodId: mood,
      sourceGardenId: root,
      mode: 'own',
    });
    await choose(child, null, 'none');
    expect(await runtime.resolveGardenMood(leaf)).toMatchObject({
      moodId: null,
      sourceGardenId: child,
      mode: 'none',
    });
    await choose(child, null);
    await runtime.close();
    runtime = await LocalGraphRuntime.open(filename);
    expect(await runtime.resolveGardenMood(leaf)).toMatchObject({
      moodId: mood,
      sourceGardenId: root,
      mode: 'own',
    });
    expect(
      (await runtime.listGardenMembers(root)).items.map((x) => x.id),
    ).toEqual([child]);
    expect(
      await runtime.all("SELECT * FROM dimensions WHERE type = 'growth'"),
    ).toEqual([]);
  });

  it('preserves existing Garden Mood content independently of its selection policy', async () => {
    const garden = await node(),
      mood = await node('workspace', 'mood');
    const content = {
      synth: { tracks: [{ brightness: 0.3 }] },
      palette: { accent: '#123456' },
    };
    await runtime.updateCrux(garden, { meta: { mood: content } });
    expect(await runtime.resolveGardenMood(garden)).toMatchObject({
      mode: 'default',
    });
    await choose(garden, mood);
    expect(
      (await runtime.execute(({ crux }) => crux.findById(garden))).meta?.mood,
    ).toEqual(content);
  });

  it('preserves unrelated metadata and refuses a stale selection without replacing it', async () => {
    const garden = await node(),
      first = await node('workspace', 'mood'),
      second = await node('workspace', 'mood');
    await runtime.updateCrux(garden, {
      meta: {
        gardenCollaboration: { marker: 'private' },
        extension: { retained: true },
      },
    });
    const expected = (await read(garden)).selection;
    await choose(garden, first);
    await expect(
      runtime.selectGardenMood({
        gardenId: garden,
        moodId: second,
        mode: 'own',
        expected,
        authorId,
        homeId,
      }),
    ).rejects.toThrow('changed');
    expect(await runtime.resolveGardenMood(garden)).toMatchObject({
      moodId: first,
    });
    expect(
      (await runtime.execute(({ crux }) => crux.findById(garden))).meta,
    ).toMatchObject({
      gardenCollaboration: { marker: 'private' },
      extension: { retained: true },
    });
  });

  it.each(['insert', 'policy', 'remove'])(
    'rolls back a silently refused %s and publishes no change, then retries',
    async (failure) => {
      const garden = await node(),
        mood = await node('workspace', 'mood'),
        second = await node('workspace', 'mood');
      if (failure === 'remove') await choose(garden, mood);
      const before = await read(garden);
      const events: unknown[] = [];
      runtime.onChange((event) => {
        events.push(event);
      });
      const trigger =
        failure === 'insert'
          ? "BEFORE INSERT ON dimensions WHEN NEW.kind = 'mood'"
          : failure === 'policy'
            ? 'BEFORE UPDATE ON cruxes'
            : "BEFORE UPDATE ON dimensions WHEN OLD.kind = 'mood'";
      await runtime.run(
        `CREATE TRIGGER refuse_mood ${trigger} BEGIN SELECT RAISE(IGNORE); END`,
      );
      await expect(choose(garden, second)).rejects.toThrow();
      expect(await read(garden)).toEqual(before);
      expect(events).toEqual([]);
      await runtime.run('DROP TRIGGER refuse_mood');
      await choose(garden, second);
      expect(await runtime.resolveGardenMood(garden)).toMatchObject({
        moodId: second,
      });
      expect(events).toHaveLength(1);
    },
  );

  it.each(['missing', 'trashed', 'wrong type'])(
    'refuses a %s Mood before replacing a selection',
    async (condition) => {
      const garden = await node(),
        good = await node('workspace', 'mood');
      await choose(garden, good);
      const bad =
        condition === 'missing'
          ? randomUUID()
          : await node('workspace', condition === 'wrong type' ? null : 'mood');
      if (condition === 'trashed')
        await runtime.run('UPDATE cruxes SET deleted = ? WHERE id = ?', [
          '2026-09-24',
          bad,
        ]);
      await expect(choose(garden, bad)).rejects.toThrow();
      expect(await runtime.resolveGardenMood(garden)).toMatchObject({
        moodId: good,
      });
    },
  );

  it('does not inherit through lateral Grafts and refuses ambiguous parents until an own choice resolves them', async () => {
    const a = await node(),
      b = await node(),
      child = await node(),
      mood = await node('workspace', 'mood');
    await choose(a, mood);
    await runtime.execute(({ dimension }) =>
      dimension.create({
        sourceId: a,
        targetId: child,
        type: DimensionType.GRAFT,
        authorId,
        homeId,
      }),
    );
    expect(await runtime.resolveGardenMood(child)).toMatchObject({
      mode: 'default',
    });
    await attach(a, child);
    await runtime.execute(({ dimension }) =>
      dimension.create({
        sourceId: b,
        targetId: child,
        type: DimensionType.GARDEN,
        kind: 'membership',
        authorId,
        homeId,
      }),
    );
    await expect(runtime.resolveGardenMood(child)).rejects.toThrow('multiple');
    await choose(child, null, 'none');
    expect(await runtime.resolveGardenMood(child)).toMatchObject({
      mode: 'none',
      sourceGardenId: child,
    });
  });

  it('refuses cycles, unsupported policy and duplicate selections instead of silently resetting', async () => {
    const a = await node(),
      b = await node(),
      mood = await node('workspace', 'mood');
    await attach(a, b);
    await runtime.execute(({ dimension }) =>
      dimension.create({
        sourceId: b,
        targetId: a,
        type: DimensionType.GARDEN,
        kind: 'membership',
        authorId,
        homeId,
      }),
    );
    await expect(runtime.resolveGardenMood(a)).rejects.toThrow('cycle');
    await choose(a, mood);
    await runtime.execute(({ dimension }) =>
      dimension.create({
        sourceId: a,
        targetId: mood,
        type: DimensionType.GRAFT,
        kind: 'mood',
        authorId,
        homeId,
      }),
    );
    await expect(read(a)).rejects.toThrow('association');
    await runtime.updateCrux(b, {
      meta: { moodSelection: { version: 900, mode: 'none' } },
    });
    await expect(read(b)).rejects.toThrow('unsupported');
  });

  it('copies an explicitly selected Mood graph with remapped associations and resolves it after restart', async () => {
    const garden = await node(),
      child = await node(),
      mood = await node('workspace', 'mood');
    await attach(garden, child);
    await choose(garden, mood);
    const store = { read: async () => null, write: async () => {} };
    const graph = await runtime.exportPrivateGraph(
      { roots: [garden, mood], includeMembers: true },
      store,
    );
    const targetPath = join(scratch, 'copy.db');
    let target = await LocalGraphRuntime.create(targetPath);
    try {
      const copy = await target.importPrivateGraph(
        {
          requestId: randomUUID(),
          mode: 'copy',
          destination: { authorId: randomUUID(), homeId: randomUUID() },
          graph,
        },
        store,
        store,
      );
      expect(await target.resolveGardenMood(copy.ids[child])).toMatchObject({
        moodId: copy.ids[mood],
        sourceGardenId: copy.ids[garden],
      });
      expect(copy.ids[mood]).not.toBe(mood);
      await target.close();
      target = await LocalGraphRuntime.open(targetPath);
      expect(await target.resolveGardenMood(copy.ids[child])).toMatchObject({
        moodId: copy.ids[mood],
        sourceGardenId: copy.ids[garden],
      });
    } finally {
      await target.close();
    }
  });

  it('allows an explicit reset of a now-missing Mood using its retained local selection', async () => {
    const garden = await node(),
      mood = await node('workspace', 'mood');
    await choose(garden, mood);
    await runtime.run('UPDATE cruxes SET deleted = ? WHERE id = ?', [
      '2026-09-24',
      mood,
    ]);
    await expect(runtime.resolveGardenMood(garden)).rejects.toThrow();
    await choose(garden, null, 'none');
    expect(await runtime.resolveGardenMood(garden)).toMatchObject({
      mode: 'none',
      moodId: null,
    });
  });
});
