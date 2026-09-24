import { mkdtempSync, rmSync } from 'fs';
import { randomUUID } from 'crypto';
import { join } from 'path';
import { tmpdir } from 'os';
import { LocalGraphRuntime } from './graph-runtime';

describe('explicit local Garden entry', () => {
  let scratch: string;
  let filename: string;
  let runtime: LocalGraphRuntime;
  beforeEach(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'garden-entry-'));
    filename = join(scratch, 'garden.db');
    runtime = await LocalGraphRuntime.create(filename);
  });
  afterEach(async () => {
    await runtime.close();
    rmSync(scratch, { recursive: true, force: true });
  });

  it('enters one actual Garden on concurrent first use and retains it after rename and restart', async () => {
    const entries = await Promise.all([
      runtime.enterLocalGarden(),
      runtime.enterLocalGarden(),
    ]);
    expect(entries[0]).toEqual(entries[1]);
    expect(entries[0]).toMatchObject({ title: 'My Garden', kind: 'garden' });
    expect(Object.keys(entries[0]).sort()).toEqual([
      'id',
      'kind',
      'slug',
      'title',
    ]);
    expect((await runtime.listGardenMembers(entries[0].id)).items).toEqual([]);
    await runtime.updateCrux(entries[0].id, { title: 'Studio' });
    await runtime.close();
    runtime = await LocalGraphRuntime.open(filename);
    expect(await runtime.enterLocalGarden()).toEqual({
      ...entries[0],
      title: 'Studio',
    });
    expect(await runtime.get('SELECT count(*) AS n FROM cruxes')).toEqual({
      n: 1,
    });
  });

  it('keeps the installation root out of ordinary Trash and permanent deletion', async () => {
    const root = await runtime.enterLocalGarden();
    await expect(runtime.setCruxTrashed(root.id, true)).rejects.toThrow(
      'local Garden entry',
    );
    await expect(runtime.deleteCrux(root.id)).rejects.toThrow(
      'local Garden entry',
    );
    expect(await runtime.enterLocalGarden()).toEqual(root);
  });

  it('rolls back identity and root when the entry reference is silently refused, then retries cleanly', async () => {
    const changes: unknown[] = [];
    runtime.onChange((change) => {
      changes.push(change);
    });
    await runtime.run(
      "CREATE TRIGGER refuse_entry BEFORE INSERT ON settings WHEN NEW.key = 'cruxgarden:local:rootGardenId' BEGIN SELECT RAISE(IGNORE); END",
    );
    await expect(runtime.enterLocalGarden()).rejects.toThrow();
    expect(await runtime.all('SELECT * FROM settings')).toEqual([]);
    expect(await runtime.get('SELECT count(*) AS n FROM cruxes')).toEqual({
      n: 0,
    });
    expect(changes).toEqual([]);
    await runtime.run('DROP TRIGGER refuse_entry');
    const root = await runtime.enterLocalGarden();
    expect(await runtime.enterLocalGarden()).toEqual(root);
    expect(changes).toHaveLength(1);
  });

  it('preserves established local attribution and never adopts unlinked Gardens or Cruxes', async () => {
    const authorId = randomUUID();
    const homeId = randomUUID();
    await runtime.run(
      "INSERT INTO settings (key, value) VALUES ('cruxgarden:local:authorId', ?), ('cruxgarden:local:homeId', ?)",
      [authorId, homeId],
    );
    const unlinked = await runtime.createCrux({
      slug: 'my-garden',
      kind: 'garden',
      authorId,
      homeId,
    });
    const root = await runtime.enterLocalGarden();
    expect(root.id).not.toBe(unlinked);
    expect(root.slug).toBe('my-garden-2');
    expect(
      await runtime.get('SELECT author_id, home_id FROM cruxes WHERE id = ?', [
        root.id,
      ]),
    ).toEqual({ author_id: authorId, home_id: homeId });
    expect((await runtime.listGardenMembers(root.id)).items).toEqual([]);
    expect(await runtime.get('SELECT count(*) AS n FROM cruxes')).toEqual({
      n: 2,
    });
  });

  it.each(['missing', 'trashed', 'wrong kind', 'invalid reference'])(
    'refuses a %s root instead of silently replacing it',
    async (condition) => {
      const root = await runtime.enterLocalGarden();
      if (condition === 'missing')
        await runtime.run('DELETE FROM cruxes WHERE id = ?', [root.id]);
      if (condition === 'trashed')
        await runtime.run(
          "UPDATE cruxes SET deleted = '2026-09-24' WHERE id = ?",
          [root.id],
        );
      if (condition === 'wrong kind')
        await runtime.updateCrux(root.id, { kind: 'snapshot' });
      if (condition === 'invalid reference')
        await runtime.run(
          "UPDATE settings SET value = 'invalid' WHERE key = 'cruxgarden:local:rootGardenId'",
        );
      const before = await runtime.all('SELECT * FROM settings ORDER BY key');
      await expect(runtime.enterLocalGarden()).rejects.toThrow();
      expect(await runtime.all('SELECT * FROM settings ORDER BY key')).toEqual(
        before,
      );
      expect(await runtime.get('SELECT count(*) AS n FROM cruxes')).toEqual({
        n: condition === 'missing' ? 0 : 1,
      });
    },
  );

  it('refuses a partial identity without changing it', async () => {
    const authorId = randomUUID();
    await runtime.run(
      "INSERT INTO settings (key,value) VALUES ('cruxgarden:local:authorId', ?)",
      [authorId],
    );
    await expect(runtime.enterLocalGarden()).rejects.toThrow(
      'identity is incomplete',
    );
    expect(await runtime.all('SELECT key, value FROM settings')).toEqual([
      { key: 'cruxgarden:local:authorId', value: authorId },
    ]);
    expect(await runtime.get('SELECT count(*) AS n FROM cruxes')).toEqual({
      n: 0,
    });
  });
});
