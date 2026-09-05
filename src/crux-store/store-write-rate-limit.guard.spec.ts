import { ExecutionContext, HttpException } from '@nestjs/common';
import {
  StoreWriteRateLimitGuard,
  storeWritesPerMinute,
  STORE_WRITE_RATE_LIMITED,
} from './store-write-rate-limit.guard';

describe('StoreWriteRateLimitGuard', () => {
  const warn = jest.fn();
  const storage = { increment: jest.fn() };
  const guard = new StoreWriteRateLimitGuard(
    storage as any,
    {
      createChildLogger: () => ({ warn }),
    } as any,
  );

  const ctx = (req: Record<string, unknown>) =>
    ({
      switchToHttp: () => ({ getRequest: () => req }),
    }) as unknown as ExecutionContext;

  beforeEach(() => {
    storage.increment.mockReset();
    warn.mockReset();
    delete process.env.STORE_WRITES_PER_MINUTE_PER_ACCOUNT;
  });

  it('reads the limit from STORE_WRITES_PER_MINUTE_PER_ACCOUNT, default 60', () => {
    expect(storeWritesPerMinute()).toBe(60);
    process.env.STORE_WRITES_PER_MINUTE_PER_ACCOUNT = '5';
    expect(storeWritesPerMinute()).toBe(5);
    process.env.STORE_WRITES_PER_MINUTE_PER_ACCOUNT = 'nope';
    expect(storeWritesPerMinute()).toBe(60);
  });

  it('lets an anonymous request through untouched (the service answers 401)', async () => {
    await expect(guard.canActivate(ctx({}))).resolves.toBe(true);
    expect(storage.increment).not.toHaveBeenCalled();
  });

  it('counts one bucket per account for a minute and passes under the limit', async () => {
    storage.increment.mockResolvedValue({ totalHits: 60, isBlocked: false });
    await expect(
      guard.canActivate(ctx({ account: { id: 'acct-1' } })),
    ).resolves.toBe(true);
    expect(storage.increment).toHaveBeenCalledWith(
      'store-writes:acct-1',
      60_000,
      60,
      60_000,
      'store-writes',
    );
  });

  it('answers 429 with a plain message over the limit and logs the account id', async () => {
    process.env.STORE_WRITES_PER_MINUTE_PER_ACCOUNT = '2';
    storage.increment.mockResolvedValue({ totalHits: 3, isBlocked: true });
    const attempt = guard.canActivate(
      ctx({ account: { id: 'acct-1' }, params: { cruxId: 'crux-1' } }),
    );
    await expect(attempt).rejects.toBeInstanceOf(HttpException);
    await attempt.catch((e: HttpException) => {
      expect(e.getStatus()).toBe(429);
      expect((e.getResponse() as any).message).toBe(STORE_WRITE_RATE_LIMITED);
    });
    expect(warn).toHaveBeenCalledWith(
      'Store write rate limit hit',
      expect.objectContaining({ accountId: 'acct-1', cruxId: 'crux-1' }),
    );
  });
});
