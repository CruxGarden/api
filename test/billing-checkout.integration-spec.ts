import { randomUUID } from 'node:crypto';
import { postgresFixture } from './support/postgres';
import { BillingRepository } from '../src/billing/billing.repository';
import { BillingService } from '../src/billing/billing.service';
import {
  MockBillingProvider,
  type CheckoutRequest,
} from '../src/billing/provider';
import { LoggerService } from '../src/common/services/logger.service';

/** Models external side effects that survive the API transaction rolling back. */
class HostedCheckoutFixture extends MockBillingProvider {
  readonly created = new Map<string, { url: string; sessionId: string }>();
  readonly requests = new Map<string, CheckoutRequest>();
  loseNextResponse = false;
  constructor() {
    super();
    Object.defineProperty(this, 'instantCheckout', { value: false });
  }
  async createCheckout(request: CheckoutRequest) {
    if (!request.idempotencyKey) throw new Error('Missing durable key');
    const previous = this.created.get(request.idempotencyKey);
    if (previous) {
      expect(request).toEqual(this.requests.get(request.idempotencyKey));
      return previous;
    }
    const sessionId = `cs_fixture_${randomUUID()}`;
    const result = {
      sessionId,
      url: `https://checkout.stripe.com/${sessionId}`,
    };
    this.created.set(request.idempotencyKey, result);
    this.requests.set(request.idempotencyKey, structuredClone(request));
    this.sessions.set(sessionId, {
      status: 'open',
      accountId: request.accountId,
      attemptId: request.idempotencyKey,
      url: result.url,
      customerId: null,
      subscriptionId: null,
    });
    if (this.loseNextResponse) {
      this.loseNextResponse = false;
      throw new Error('Provider response lost');
    }
    return result;
  }
  complete(sessionId: string) {
    const session = this.sessions.get(sessionId)!;
    const request = [...this.requests.values()].find(
      (r) => this.created.get(r.idempotencyKey!)?.sessionId === sessionId,
    )!;
    const customerId = `cus_${session.accountId}`,
      subscriptionId = `sub_${sessionId}`;
    this.subscriptions.set(subscriptionId, {
      accountId: session.accountId,
      customerId,
      subscriptionId,
      priceId: request.priceId,
      status: 'active',
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 30 * 86400000),
      cancelAtPeriodEnd: false,
      trialEnd: null,
    });
    this.sessions.set(sessionId, {
      ...session,
      customerId,
      subscriptionId,
      status: 'complete',
      url: null,
    });
  }
}

describe('durable external checkout ownership', () => {
  let fixture: Awaited<ReturnType<typeof postgresFixture>>;
  let repo: BillingRepository;
  let service: BillingService;
  let provider: HostedCheckoutFixture;
  const logger = new LoggerService();
  const home = randomUUID(),
    account = randomUUID();
  const env = { ...process.env };
  const openService = () => {
    service = new BillingService(repo, logger, { send: jest.fn() } as never);
    service.useProvider(provider, {
      monthly: { planId: 'gardener', interval: 'month' },
      yearly: { planId: 'gardener', interval: 'year' },
    });
  };
  beforeAll(async () => {
    delete process.env.BILLING_PROVIDER;
    delete process.env.STRIPE_SECRET_KEY;
    process.env.STRIPE_TRIAL_DAYS = '0';
    fixture = await postgresFixture();
    repo = new BillingRepository(fixture.db, logger);
    await fixture.db.query()('homes').insert({
      id: home,
      name: 'Checkout fixture',
      type: 'home',
      kind: 'garden',
      primary: true,
    });
    await fixture.db.query()('accounts').insert({
      id: account,
      home_id: home,
      email: 'checkout@example.test',
      role: 'author',
    });
  }, 60_000);
  beforeEach(async () => {
    for (const table of [
      'subscriptions',
      'billing_checkout_attempts',
      'billing_account_state',
    ])
      await fixture.db.query()(table).delete();
    provider = new HostedCheckoutFixture();
    openService();
  });
  afterAll(async () => {
    process.env = { ...env };
    await fixture?.close();
  });

  it('reuses one session for simultaneous requests and refuses a conflicting price until cancellation', async () => {
    const [first, second] = await Promise.all([
      service.checkout(account, 'gardener', 'month'),
      service.checkout(account, 'gardener', 'month'),
    ]);
    expect(first).toEqual(second);
    expect(provider.created.size).toBe(1);
    expect((await service.me(account)).pendingCheckout).toBe(true);
    await expect(service.checkout(account, 'gardener', 'year')).rejects.toThrow(
      'pending checkout',
    );
    await service.cancelCheckout(account);
    expect((await service.me(account)).pendingCheckout).toBe(false);
    const next = await service.checkout(account, 'gardener', 'year');
    expect(next.url).not.toBe(first.url);
    expect(provider.created.size).toBe(2);
  });

  it('recovers the same external session after a lost response and API restart', async () => {
    provider.loseNextResponse = true;
    await expect(
      service.checkout(account, 'gardener', 'month'),
    ).rejects.toThrow('Provider response lost');
    const intent = (await repo.checkoutAttempt(account)).data!;
    expect(intent.status).toBe('preparing');
    expect(intent.session_id).toBeNull();
    expect(provider.created.size).toBe(1);
    await fixture.db
      .query()('accounts')
      .where({ id: account })
      .update({ email: 'updated@example.test' });
    openService();
    expect(await service.resumeCheckout(account)).toEqual({
      url: provider.created.get(intent.id)!.url,
    });
    expect(provider.created.size).toBe(1);
    expect((await repo.checkoutAttempt(account)).data!.id).toBe(intent.id);
  });

  it('keeps the committed intent when saving the external result fails', async () => {
    const db = fixture.db.query();
    await db.raw(
      "CREATE FUNCTION refuse_checkout_result() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status = 'open' THEN RAISE EXCEPTION 'fixture write refusal'; END IF; RETURN NEW; END $$",
    );
    await db.raw(
      'CREATE TRIGGER refuse_checkout_result BEFORE UPDATE ON billing_checkout_attempts FOR EACH ROW EXECUTE FUNCTION refuse_checkout_result()',
    );
    try {
      await expect(
        service.checkout(account, 'gardener', 'month'),
      ).rejects.toThrow('Checkout state');
    } finally {
      await db.raw(
        'DROP TRIGGER refuse_checkout_result ON billing_checkout_attempts',
      );
      await db.raw('DROP FUNCTION refuse_checkout_result()');
    }
    expect((await repo.checkoutAttempt(account)).data!.status).toBe(
      'preparing',
    );
    await service.resumeCheckout(account);
    expect(provider.created.size).toBe(1);
  });

  it('synchronizes a checkout that completed during cancellation instead of claiming it was canceled', async () => {
    await service.checkout(account, 'gardener', 'month');
    const attempt = (await repo.checkoutAttempt(account)).data!;
    provider.complete(attempt.session_id!);
    const result = await service.cancelCheckout(account);
    expect(result.plan.id).toBe('gardener');
    expect(result.pendingCheckout).toBe(false);
    await expect(
      service.checkout(account, 'gardener', 'month'),
    ).rejects.toThrow('already have a plan');
    expect(provider.created.size).toBe(1);
  });

  it('commits a recovered paid plan even when another purchase is refused', async () => {
    await service.checkout(account, 'gardener', 'month');
    const attempt = (await repo.checkoutAttempt(account)).data!;
    provider.complete(attempt.session_id!);
    await expect(service.checkout(account, 'gardener', 'year')).rejects.toThrow(
      'already have a plan',
    );
    openService();
    expect((await service.me(account)).plan.id).toBe('gardener');
    expect((await service.me(account)).pendingCheckout).toBe(false);
    expect(provider.created.size).toBe(1);
  });

  it('persists the account-closing fence through cleanup failure and restart', async () => {
    await service.checkout(account, 'gardener', 'month');
    const closing = jest
      .spyOn(provider, 'closeAccount')
      .mockRejectedValueOnce(new Error('Provider temporarily unavailable'));
    await expect(service.closeAccount(account)).rejects.toThrow(
      'Provider temporarily unavailable',
    );
    openService();
    await expect(
      service.checkout(account, 'gardener', 'month'),
    ).rejects.toThrow('closure is in progress');
    await service.closeAccount(account);
    expect(closing).toHaveBeenCalledTimes(2);
    expect(provider.created.size).toBe(1);
  });

  it('recovers an old ambiguous attempt only from matching provider metadata', async () => {
    provider.loseNextResponse = true;
    await expect(
      service.checkout(account, 'gardener', 'month'),
    ).rejects.toThrow();
    const attempt = (await repo.checkoutAttempt(account)).data!;
    const created = provider.created.get(attempt.id)!;
    const session = provider.sessions.get(created.sessionId)!;
    provider.sessions.set('cs_wrong_attempt', {
      ...session,
      attemptId: randomUUID(),
    });
    await expect(
      service.recoverCheckout(account, 'cs_wrong_attempt'),
    ).rejects.toThrow('does not belong');
    expect((await repo.checkoutAttempt(account)).data!.session_id).toBeNull();
    provider.complete(created.sessionId);
    expect(
      (await service.recoverCheckout(account, created.sessionId)).plan.id,
    ).toBe('gardener');
    expect((await service.me(account)).pendingCheckout).toBe(false);
    expect(provider.created.size).toBe(1);
  });

  it('refuses an ambiguous request after the provider idempotency retention window', async () => {
    provider.loseNextResponse = true;
    await expect(
      service.checkout(account, 'gardener', 'month'),
    ).rejects.toThrow();
    await fixture.db
      .query()('billing_checkout_attempts')
      .where({ account_id: account })
      .update({ created_at: new Date(Date.now() - 24 * 60 * 60_000) });
    await expect(service.resumeCheckout(account)).rejects.toThrow(
      'operator recovery',
    );
    expect(provider.created.size).toBe(1);
  });
});
