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
