import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { LocalGraphRuntime } from './graph-runtime';

describe('owned installation settings', () => {
  let dir: string;
  let owner: LocalGraphRuntime;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'crux-settings-command-'));
    owner = await LocalGraphRuntime.create(join(dir, 'garden.db'));
  });
  afterEach(async () => {
    await owner.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('puts, replaces, lists and removes settings across restart', async () => {
    await owner.putSetting('cruxgarden:a', '1');
    await owner.putSetting('cruxgarden:b', 'two');
    await owner.putSetting('cruxgarden:a', 'one');
    await owner.removeSetting('cruxgarden:missing');
    await owner.close();
    owner = await LocalGraphRuntime.open(join(dir, 'garden.db'));
    const rows = await owner.listSettings();
    expect(rows.filter((r) => r.key.startsWith('cruxgarden:'))).toEqual(
      expect.arrayContaining([
        { key: 'cruxgarden:a', value: 'one' },
        { key: 'cruxgarden:b', value: 'two' },
      ]),
    );
    await owner.removeSetting('cruxgarden:b');
    expect(
      (await owner.listSettings()).some((r) => r.key === 'cruxgarden:b'),
    ).toBe(false);
  });

  it('refuses keys and values that are not text', async () => {
    await expect(owner.putSetting('', 'x')).rejects.toThrow();
    await expect(
      owner.putSetting('cruxgarden:x', 3 as unknown as string),
    ).rejects.toThrow();
    await expect(owner.removeSetting('')).rejects.toThrow();
  });

  it.each([
    'cruxgarden:authSession',
    'cruxgarden:accessToken',
    'cruxgarden:refreshToken',
    'cruxgarden:apiKey:anthropic',
    'cruxgarden:fn-secrets:fixture-crux',
    'apiKey:anthropic',
    'cruxgarden:anthropicApiKey',
  ])(
    'refuses credential persistence through the named settings command: %s',
    async (key) => {
      await expect(owner.putSetting(key, 'fixture-secret')).rejects.toThrow(
        /credential|secret/i,
      );
      expect((await owner.listSettings()).some((row) => row.key === key)).toBe(
        false,
      );
    },
  );

  it('exports an image without active or deleted credential bytes while preserving the live installation', async () => {
    await owner.close();
    const Database = require('better-sqlite3');
    const fixture = new Database(join(dir, 'garden.db'));
    const retained = 'fixture-retained-private-credential';
    const deleted = 'fixture-deleted-private-credential';
    fixture.pragma('secure_delete = OFF');
    fixture
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
      .run('cruxgarden:theme', 'dark');
    fixture
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
      .run('cruxgarden:authSession', retained);
    fixture
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
      .run('cruxgarden:apiKey:fixture', deleted.repeat(500));
    fixture
      .prepare('DELETE FROM settings WHERE key = ?')
      .run('cruxgarden:apiKey:fixture');
    expect(
      Buffer.from(fixture.serialize()).includes(Buffer.from(deleted)),
    ).toBe(true);
    fixture.close();
    owner = await LocalGraphRuntime.open(join(dir, 'garden.db'));
    const image = Buffer.from(await owner.exportDatabase());
    expect(image.includes(Buffer.from(retained))).toBe(false);
    expect(image.includes(Buffer.from(deleted))).toBe(false);
    image[18] = image[19] = 1;
    const restored = new Database(image, { readonly: true });
    try {
      expect(
        restored
          .prepare('SELECT value FROM settings WHERE key = ?')
          .get('cruxgarden:theme'),
      ).toEqual({ value: 'dark' });
      expect(
        restored
          .prepare('SELECT value FROM settings WHERE key = ?')
          .get('cruxgarden:authSession'),
      ).toBeUndefined();
    } finally {
      restored.close();
    }
    expect(
      (await owner.listSettings()).some(
        (row) => row.key === 'cruxgarden:authSession',
      ),
    ).toBe(false);
    expect(
      await owner.get('SELECT value FROM settings WHERE key = ?', [
        'cruxgarden:authSession',
      ]),
    ).toEqual({ value: retained });
  });

  it('keeps admission order: queued writes land in the order they were made', async () => {
    const writes = Array.from({ length: 20 }, (_, i) =>
      owner.putSetting('cruxgarden:order', String(i)),
    );
    await Promise.all(writes);
    const row = (await owner.listSettings()).find(
      (r) => r.key === 'cruxgarden:order',
    );
    expect(row?.value).toBe('19');
  });
});
