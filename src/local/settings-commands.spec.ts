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
