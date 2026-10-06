import { StoreService } from './store.service';

it('refuses partial shared-prefix deletion and retries the remaining objects', async () => {
  const logger = {
    createChildLogger: () => ({ info: jest.fn(), warn: jest.fn() }),
  } as never;
  const store = new StoreService(logger);
  const send = jest
    .fn()
    .mockResolvedValueOnce({ Contents: [{ Key: 'crux/index.html' }] })
    .mockResolvedValueOnce({
      Errors: [{ Key: 'crux/index.html', Code: 'AccessDenied' }],
    });
  // Replace only the external S3 boundary; run the actual prefix deletion logic.
  Object.assign(store, { mockMode: false, s3Client: { send } });
  await expect(store.deleteByPrefix({ prefix: 'crux/' })).rejects.toThrow(
    /delete/i,
  );
  send
    .mockResolvedValueOnce({ Contents: [{ Key: 'crux/index.html' }] })
    .mockResolvedValueOnce({});
  await expect(store.deleteByPrefix({ prefix: 'crux/' })).resolves.toBe(1);
});

import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('local storage preservation and refusal', () => {
  const env = { ...process.env };
  let root: string;
  let store: StoreService;
  const logger = {
    createChildLogger: () => ({ info: jest.fn(), warn: jest.fn() }),
  } as never;
  beforeEach(async () => {
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    root = await fs.mkdtemp(join(tmpdir(), 'crux-store-owned-'));
    process.env.LOCAL_STORE_DIR = root;
    store = new StoreService(logger);
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    process.env = { ...env };
    await fs.rm(root, { recursive: true, force: true });
  });
  it('preserves the prior file if atomic replacement is refused and removes only its own temporary file', async () => {
    await store.upload({
      namespace: 'fixture',
      path: 'backup',
      data: Buffer.from('original'),
    });
    jest.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('rename refused'));
    await expect(
      store.upload({
        namespace: 'fixture',
        path: 'backup',
        data: Buffer.from('replacement'),
      }),
    ).rejects.toThrow('rename refused');
    expect(
      (
        await store.download({ namespace: 'fixture', path: 'backup' })
      ).data.toString(),
    ).toBe('original');
    expect(await fs.readdir(join(root, 'fixture'))).toEqual(['backup']);
    await store.upload({
      namespace: 'fixture',
      path: 'backup',
      data: Buffer.from('retry'),
    });
    expect(
      (
        await store.download({ namespace: 'fixture', path: 'backup' })
      ).data.toString(),
    ).toBe('retry');
  });
  it('propagates deletion refusal instead of returning success', async () => {
    await store.upload({
      namespace: 'fixture',
      path: 'backup',
      data: Buffer.from('original'),
    });
    jest
      .spyOn(fs, 'rm')
      .mockRejectedValueOnce(
        Object.assign(new Error('denied'), { code: 'EACCES' }),
      );
    await expect(
      store.delete({ namespace: 'fixture', path: 'backup' }),
    ).rejects.toThrow('denied');
    expect(
      (
        await store.download({ namespace: 'fixture', path: 'backup' })
      ).data.toString(),
    ).toBe('original');
    await store.delete({ namespace: 'fixture', path: 'backup' });
    await expect(
      store.delete({ namespace: 'fixture', path: 'absent' }),
    ).resolves.toBeUndefined();
  });
  it('distinguishes an absent prefix from unavailable directory enumeration', async () => {
    expect(
      await store.deleteByPrefix({ namespace: 'absent', prefix: 'backup/' }),
    ).toBe(0);
    await store.upload({
      namespace: 'fixture',
      path: 'backup/file',
      data: Buffer.from('saved'),
    });
    jest
      .spyOn(fs, 'readdir')
      .mockRejectedValueOnce(
        Object.assign(new Error('denied'), { code: 'EACCES' }),
      );
    await expect(
      store.deleteByPrefix({ namespace: 'fixture', prefix: 'backup/' }),
    ).rejects.toThrow('denied');
    expect(
      (
        await store.download({ namespace: 'fixture', path: 'backup/file' })
      ).data.toString(),
    ).toBe('saved');
  });
});
