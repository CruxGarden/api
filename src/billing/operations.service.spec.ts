import { BillingOperationsService } from './operations.service';
import { LoggerService } from '../common/services/logger.service';
import { success } from '../common/helpers/repository-helpers';

describe('billing worker lifecycle', () => {
  const env = { ...process.env };
  beforeEach(() => {
    jest.useFakeTimers();
    process.env.NODE_ENV = 'development';
    delete process.env.BILLING_RECONCILIATION;
  });
  afterEach(() => {
    jest.useRealTimers();
    process.env = { ...env };
  });
  function fixture(providerName = 'stripe') {
    const repo = {
      discover: jest.fn(async () => success(undefined)),
      candidates: jest.fn(async () => success([])),
      dueNotices: jest.fn(async () => success([])),
    };
    const worker = new BillingOperationsService(
      { providerName } as never,
      repo as never,
      { deliveryMode: 'ses' } as never,
      new LoggerService(),
    );
    return { worker, repo };
  }
  it('starts only for Stripe, prevents overlapping batches, and stops cleanly', async () => {
    const { worker, repo } = fixture();
    let finish!: () => void;
    repo.discover.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(success(undefined));
        }),
    );
    worker.onModuleInit();
    await jest.advanceTimersByTimeAsync(120_000);
    expect(repo.discover).toHaveBeenCalledTimes(1);
    finish();
    await worker.sweep();
    await worker.onModuleDestroy();
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(120_000);
    expect(repo.discover).toHaveBeenCalledTimes(1);
  });
  it('never starts automatically for simulation, mock, tests or an explicitly disabled worker', async () => {
    for (const name of ['simulation', 'mock']) {
      const { worker, repo } = fixture(name);
      worker.onModuleInit();
      expect(repo.discover).not.toHaveBeenCalled();
      await worker.onModuleDestroy();
    }
    process.env.NODE_ENV = 'test';
    const test = fixture();
    test.worker.onModuleInit();
    expect(test.repo.discover).not.toHaveBeenCalled();
    process.env.NODE_ENV = 'production';
    process.env.BILLING_RECONCILIATION = '0';
    const disabled = fixture();
    disabled.worker.onModuleInit();
    expect(disabled.repo.discover).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('delivers a notice addressed at enqueue time after the account is closed (ADR 0083)', async () => {
    jest.useRealTimers();
    const notice = {
      id: 'notice',
      account_id: 'closed-account',
      subject: 'Your Crux Garden account is closed',
      body: 'links',
      attempts: 0,
      lease_id: null,
      condition: null,
      recipient_email: 'gone@example.com',
    };
    const repo = {
      dueNotices: jest.fn(async () => success([notice])),
      claimNotice: jest.fn(async () => success('lease')),
      recipient: jest.fn(async () => success(null)),
      finishNotice: jest.fn(async () => success(true)),
    };
    const send = jest.fn(async () => undefined);
    const worker = new BillingOperationsService(
      { providerName: 'stripe' } as never,
      repo as never,
      { deliveryMode: 'ses', send } as never,
      new LoggerService(),
    );
    expect(await worker.deliverNotices()).toBe(1);
    expect(send).toHaveBeenCalledWith({
      email: 'gone@example.com',
      subject: notice.subject,
      body: 'links',
    });
    expect(repo.recipient).not.toHaveBeenCalled();
    expect(repo.finishNotice).toHaveBeenCalledWith(
      notice,
      'lease',
      expect.any(Date),
      null,
      'sent',
    );
  });
});
