import { randomUUID } from 'crypto';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { LocalGraphRuntime } from './graph-runtime';

describe('named installation commands', () => {
  let dir: string;
  let owner: LocalGraphRuntime;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'crux-installation-commands-'));
    owner = await LocalGraphRuntime.create(join(dir, 'garden.db'));
  });
  afterEach(async () => {
    await owner.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const setting = async (key: string) =>
    (await owner.listSettings()).find((r) => r.key === key)?.value;

  it('creates the local author and records it in one step', async () => {
    const author = await owner.createAuthor({
      username: 'wanderer-1',
      local: true,
    });
    expect(author).toMatchObject({
      username: 'wanderer-1',
      account_id: `local-${author.id}`,
    });
    expect(await setting('cruxgarden:localAuthorId')).toBe(author.id);
  });

  it('updates an author, merging metadata, and refuses a missing one', async () => {
    const author = await owner.createAuthor({ username: 'a' });
    await owner.updateAuthor(author.id, {
      displayName: 'Ada',
      meta: { one: 1 },
    });
    await owner.updateAuthor(author.id, { meta: { two: 2 } });
    const row = await owner.get<{ display_name: string; meta: string }>(
      'SELECT display_name, meta FROM authors WHERE id = ?',
      [author.id],
    );
    expect(row?.display_name).toBe('Ada');
    expect(JSON.parse(row!.meta)).toEqual({ one: 1, two: 2 });
    await expect(
      owner.updateAuthor(randomUUID(), { bio: 'x' }),
    ).rejects.toThrow('Author not found');
  });

  it('re-keys the local author everywhere or nowhere', async () => {
    const author = await owner.createAuthor({ username: 'local', local: true });
    await owner.run(
      "INSERT INTO dimensions (id, source_id, target_id, type, home_id, author_id, meta, created, updated) VALUES ('d', 's', 't', 'graft', 'h', ?, '{}', 'x', 'x')",
      [author.id],
    );
    // The account's author already exists here: the rename conflicts mid-way.
    const taken = await owner.createAuthor({ username: 'taken' });
    const outcome = await owner
      .rekeyLocalAuthor({ oldId: author.id, newId: taken.id, accountId: 'acc' })
      .then(
        () => 'resolved',
        (e: unknown) => String(e),
      );
    expect(outcome).toMatch(/UNIQUE|constraint/i);
    const kept = await owner.get<{ author_id: string }>(
      "SELECT author_id FROM dimensions WHERE id = 'd'",
    );
    expect(kept?.author_id).toBe(author.id);
    expect(await setting('cruxgarden:localAuthorId')).toBe(author.id);
    await owner.rekeyLocalAuthor({
      oldId: author.id,
      newId: 'account-author',
      accountId: 'acc',
    });
    expect(
      (
        await owner.get<{ author_id: string }>(
          "SELECT author_id FROM dimensions WHERE id = 'd'",
        )
      )?.author_id,
    ).toBe('account-author');
    expect(await setting('cruxgarden:localAuthorId')).toBe('account-author');
  });

  it('creates, updates and deletes Dimensions', async () => {
    const { id } = await owner.createDimension({
      sourceId: 'a',
      targetId: 'b',
      type: 'graft',
      homeId: 'home',
      meta: { x: 1 },
    });
    await owner.updateDimension(id, { note: 'kin', meta: { y: 2 } });
    const row = await owner.get<{ note: string; meta: string }>(
      'SELECT note, meta FROM dimensions WHERE id = ?',
      [id],
    );
    expect(row?.note).toBe('kin');
    expect(JSON.parse(row!.meta)).toEqual({ x: 1, y: 2 });
    await expect(
      owner.createDimension({
        sourceId: 'a',
        targetId: 'b',
        type: 'nope',
        homeId: 'h',
      }),
    ).rejects.toThrow('Dimension type');
    await owner.deleteDimension(id);
    expect(
      await owner.get('SELECT id FROM dimensions WHERE id = ?', [id]),
    ).toBeUndefined();
  });

  it('keeps one Store entry per key, public or per visitor, and clears a Crux', async () => {
    await owner.storeSet({
      cruxId: 'c',
      key: 'score',
      value: '1',
      mode: 'public',
    });
    await owner.storeSet({
      cruxId: 'c',
      key: 'score',
      value: '2',
      mode: 'public',
    });
    await owner.storeSet({
      cruxId: 'c',
      key: 'score',
      visitorId: 'v',
      value: '9',
      mode: 'protected',
    });
    const rows = await owner.all<{ visitor_id: string | null; value: string }>(
      'SELECT visitor_id, value FROM store WHERE crux_id = ? ORDER BY visitor_id',
      ['c'],
    );
    expect(rows).toEqual([
      { visitor_id: null, value: '2' },
      { visitor_id: 'v', value: '9' },
    ]);
    await owner.storeDelete({ cruxId: 'c', key: 'score', visitorId: 'v' });
    expect(
      await owner.all('SELECT id FROM store WHERE crux_id = ?', ['c']),
    ).toHaveLength(1);
    await owner.storeClear('c');
    expect(
      await owner.all('SELECT id FROM store WHERE crux_id = ?', ['c']),
    ).toHaveLength(0);
  });

  it('wipes the Garden in one transaction', async () => {
    await owner.createAuthor({ username: 'x', local: true });
    await owner.run(
      "CREATE TRIGGER refuse BEFORE DELETE ON settings BEGIN SELECT RAISE(ABORT, 'refused'); END",
    );
    const outcome = await owner.wipeGarden().then(
      () => 'resolved',
      (e: unknown) => String(e),
    );
    expect(outcome).toContain('refused');
    expect(await owner.all('SELECT id FROM authors')).toHaveLength(1);
    await owner.run('DROP TRIGGER refuse');
    await owner.wipeGarden();
    expect(await owner.all('SELECT id FROM authors')).toHaveLength(0);
    expect(await owner.listSettings()).toEqual([]);
  });
});
