import { ForbiddenException } from '@nestjs/common';
import {
  ACCOUNT_SUSPENDED_MESSAGE,
  BillingService,
} from '../billing/billing.service';
import { LimitsService, OverLimitException } from './limits.service';

const GB = 1024 ** 3;

function svc(planId: string, storageBytes: number) {
  const usage = { forAuthor: jest.fn(async () => ({ storageBytes })) };
  const billing = {
    planIdFor: jest.fn(async () => planId),
    assertNotSuspended: jest.fn(async () => undefined),
  };
  return new LimitsService(usage as never, billing as never);
}

describe('LimitsService (grace-first)', () => {
  it('allows up to the soft limit without a warning', async () => {
    const r = await svc('free', 0.5 * GB).assertStorage('a1', 'acct', 0.5 * GB);
    expect(r).toMatchObject({ limit: GB, warn: false });
  });

  it('warns between soft limit and 2×, refuses beyond 2× with a 402 naming the plan', async () => {
    const warn = await svc('free', 1.2 * GB).assertStorage(
      'a1',
      'acct',
      0.1 * GB,
    );
    expect(warn.warn).toBe(true);
    await expect(
      svc('free', 1.9 * GB).assertStorage('a1', 'acct', 0.2 * GB),
    ).rejects.toThrow(OverLimitException);
    const err = (await svc('free', 1.9 * GB)
      .assertStorage('a1', 'acct', 0.2 * GB, 0, 'publish')
      .catch((e: unknown) => e)) as OverLimitException;
    expect(err).toBeInstanceOf(OverLimitException);
    const res = err.getResponse() as Record<string, unknown>;
    expect(err.getStatus()).toBe(402);
    expect(res.kind).toBe('storage');
    expect(String(res.message)).toMatch(/Free plan/);
    expect(String(res.message)).toMatch(/upgrade your plan/);
  });

  it('a replaced object only counts its growth; bigger plans have bigger lines', async () => {
    // 1.95 GB used, republishing a 1 GB crux as 1.1 GB → net 2.05 GB > 2 GB hard line
    await expect(
      svc('free', 1.95 * GB).assertStorage('a1', 'acct', 1.1 * GB, 1 * GB),
    ).rejects.toThrow();
    // same numbers on Gardener (10 GB) are nowhere near the line
    const r = await svc('gardener', 1.95 * GB).assertStorage(
      'a1',
      'acct',
      1.1 * GB,
      1 * GB,
    );
    expect(r.limit).toBe(10 * GB);
    expect(r.warn).toBe(false);
  });

  it('refuses a suspended account with 403 before measuring storage (ADR 0083)', async () => {
    const usage = { forAuthor: jest.fn() };
    const repo = {
      accountSuspension: jest.fn(async () => ({
        data: { suspended: new Date(), reason: 'spam' },
        error: null,
      })),
      authorSuspension: jest.fn(async () => ({
        data: { suspended: new Date(), reason: 'spam' },
        error: null,
      })),
    };
    const billing = new BillingService(
      repo as never,
      {
        createChildLogger: () => ({
          info: jest.fn(),
          warn: jest.fn(),
          error: jest.fn(),
        }),
      } as never,
      {} as never,
    );
    const limits = new LimitsService(usage as never, billing);
    const refusal = (await limits
      .assertStorage('author', 'acct', 1)
      .catch((e: unknown) => e)) as ForbiddenException;
    expect(refusal).toBeInstanceOf(ForbiddenException);
    expect(refusal.message).toBe(ACCOUNT_SUSPENDED_MESSAGE);
    expect(usage.forAuthor).not.toHaveBeenCalled();
    await expect(limits.assertAuthorNotSuspended('author')).rejects.toThrow(
      ACCOUNT_SUSPENDED_MESSAGE,
    );
    repo.accountSuspension.mockResolvedValueOnce({
      data: { suspended: null, reason: null },
      error: null,
    } as never);
    await expect(limits.assertNotSuspended('acct')).resolves.toBeUndefined();
    // Fails closed: an unreadable hold refuses the write.
    repo.accountSuspension.mockResolvedValueOnce({
      data: null,
      error: new Error('db'),
    } as never);
    await expect(limits.assertNotSuspended('acct')).rejects.toMatchObject({
      status: 503,
    });
    // No account (anonymous or self-hosted path): nothing to check.
    await expect(limits.assertNotSuspended(null)).resolves.toBeUndefined();
  });
});
