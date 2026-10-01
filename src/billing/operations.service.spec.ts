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
});
