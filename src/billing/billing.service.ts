import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { LoggerService } from '../common/services/logger.service';
import { toEntityFields } from '../common/helpers/case-helpers';
import { EmailService } from '../common/services/email.service';
import { paymentFailedEmail, planChangedEmail } from './billing.emails';
import { BillingRepository, type SubscriptionRow } from './billing.repository';
import {
  MockBillingProvider,
  type BillingEvent,
  type BillingProvider,
  type PriceInfo,
  type SubscriptionSnapshot,
} from './provider';
import { BillingSimulationRepository } from './simulation.repository';
import {
  SimulationBillingProvider,
  type SimulationAction,
} from './simulation.provider';
import { stripeProviderFromEnv } from './stripe.provider';
import {
  PLANS,
  PLAN_ORDER,
  planById,
  type BillingInterval,
  type PaidPlanId,
  type Plan,
} from '../usage/plans';

interface BillingNotification {
  accountId: string;
  message: { subject: string; body: string };
}

/** What the app shows on Settings → Plan. */
export interface BillingMe {
  plan: Plan;
  status: string;
  interval: BillingInterval | null;
  renewsAt: string | null;
  cancelAtPeriodEnd: boolean;
  trialEndsAt: string | null;
  /** the account has a provider customer → the portal can be opened */
  canManage: boolean;
  provider: string;
}

export interface CatalogPlan {
  plan: Plan;
  prices: {
    interval: BillingInterval;
    priceId: string;
    amount: number;
    currency: string;
  }[];
}

export interface Catalog {
  plans: CatalogPlan[];
  trialDays: number;
  provider: string;
  /** the mock provider "pays" instantly — the app skips the browser hop */
  instant: boolean;
}

/** Past-due accounts keep their plan this long before dropping to free. */
const PAST_DUE_GRACE_DAYS = 7;

@Injectable()
export class BillingService {
  private readonly logger: LoggerService;
  private provider: BillingProvider;
  private priceMap: Map<
    string,
    { planId: PaidPlanId; interval: BillingInterval }
  >;
  private catalogCache: { at: number; prices: PriceInfo[] } | null = null;

  constructor(
    private readonly repo: BillingRepository,
    loggerService: LoggerService,
    private readonly email: EmailService,
    @Optional() simulationRepo?: BillingSimulationRepository,
  ) {
    this.logger = loggerService.createChildLogger('BillingService');
    if (process.env.BILLING_PROVIDER === 'simulation') {
      if (!simulationRepo) throw new Error('Simulation repository is required');
      if (
        process.env.NODE_ENV === 'production' &&
        process.env.BILLING_ALLOW_MOCK !== '1'
      )
        throw new Error(
          'Simulation in production requires BILLING_ALLOW_MOCK=1',
        );
      this.provider = new SimulationBillingProvider(simulationRepo);
      this.priceMap = new Map(
        (['gardener', 'gardener_plus'] as const).flatMap((planId) =>
          (['month', 'year'] as const).map(
            (interval) =>
              [
                `price_mock_${planId}_${interval}`,
                { planId, interval },
              ] as const,
          ),
        ),
      );
      this.logger.warn(
        'Billing SIMULATION enabled — no payments or billing emails',
      );
      return;
    }
    const stripe = stripeProviderFromEnv();
    this.provider = stripe ?? new MockBillingProvider();
    if (!stripe) {
      // A mock checkout "succeeds" for free. That must never reach a real
      // deployment by accident — refuse to boot unless explicitly allowed.
      if (
        process.env.NODE_ENV === 'production' &&
        process.env.BILLING_ALLOW_MOCK !== '1'
      )
        throw new Error(
          'BillingService: STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET missing in production — set them, or BILLING_ALLOW_MOCK=1 to run the mock provider on purpose',
        );
      this.logger.warn(
        'Billing in MOCK mode — STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET not set; checkouts succeed instantly',
      );
    }
    this.priceMap = priceMapFromEnv(this.provider.name === 'mock');
  }

  /** tests */
  useProvider(
    p: BillingProvider,
    prices?: Record<string, { planId: PaidPlanId; interval: BillingInterval }>,
  ) {
    this.provider = p;
    if (prices) this.priceMap = new Map(Object.entries(prices));
    this.catalogCache = null;
  }

  get providerName(): string {
    return this.provider.name;
  }

  // ── Plan resolution ─────────────────────────────────────────────────────
  /** The plan an account is entitled to right now. Never trusts the client. */
  async planIdFor(
    accountId: string | null | undefined,
    now = new Date(),
  ): Promise<string> {
    if (!accountId) return 'free';
    const r = await this.repo.byAccount(accountId);
    if (r.error)
      throw new ServiceUnavailableException(
        'Subscription status is unavailable.',
      );
    return effectivePlanId(this.matchingProvider(r.data), now);
  }

  async me(accountId: string, now = new Date()): Promise<BillingMe> {
    const result = await this.repo.byAccount(accountId);
    if (result.error)
      throw new ServiceUnavailableException(
        'Subscription status is unavailable.',
      );
    const row = this.matchingProvider(result.data);
    const planId = effectivePlanId(row, now);
    return {
      plan: planById(planId),
      status: row?.status ?? 'none',
      interval: (row?.interval as BillingInterval | null) ?? null,
      renewsAt: row?.current_period_end
        ? new Date(row.current_period_end).toISOString()
        : null,
      cancelAtPeriodEnd: !!row?.cancel_at_period_end,
      trialEndsAt: row?.trial_end
        ? new Date(row.trial_end).toISOString()
        : null,
      canManage: !!row?.customer_id && this.provider.name !== 'simulation',
      provider: this.provider.name,
    };
  }

  // ── Catalog ─────────────────────────────────────────────────────────────
  async catalog(): Promise<Catalog> {
    const ids = [...this.priceMap.keys()];
    if (!this.catalogCache || Date.now() - this.catalogCache.at > 10 * 60_000) {
      const prices = ids.length ? await this.provider.prices(ids) : [];
      this.catalogCache = { at: Date.now(), prices };
    }
    const byId = new Map(this.catalogCache.prices.map((p) => [p.priceId, p]));
    const plans: CatalogPlan[] = PLAN_ORDER.map((id) => ({
      plan: PLANS[id],
      prices: [...this.priceMap.entries()]
        .filter(([, v]) => v.planId === id)
        .map(([priceId, v]) => {
          const p = byId.get(priceId);
          return p && p.interval === v.interval
            ? {
                interval: v.interval,
                priceId,
                amount: p.amount,
                currency: p.currency,
              }
            : null;
        })
        .filter((x): x is NonNullable<typeof x> => !!x)
        .sort(
          (a, b) =>
            (a.interval === 'month' ? -1 : 1) -
            (b.interval === 'month' ? -1 : 1),
        ),
    }));
    return {
      plans,
      trialDays: trialDays(),
      provider: this.provider.name,
      instant: !!this.provider.instantCheckout,
    };
  }

  // ── Checkout / portal ───────────────────────────────────────────────────
  async checkout(
    accountId: string,
    planId: string,
    interval: BillingInterval,
  ): Promise<{ url: string }> {
    return this.withAccount(accountId, (notifications) =>
      this.startCheckout(accountId, planId, interval, notifications),
    );
  }

  private async startCheckout(
    accountId: string,
    planId: string,
    interval: BillingInterval,
    notifications: BillingNotification[],
  ): Promise<{ url: string }> {
    const entry = [...this.priceMap.entries()].find(
      ([, v]) => v.planId === planId && v.interval === interval,
    );
    if (!entry) throw new BadRequestException('That plan is not available');
    const [priceId] = entry;
    const catalog = await this.catalog();
    if (
      !catalog.plans.some(
        (p) =>
          p.plan.id === planId &&
          p.prices.some((price) => price.priceId === priceId),
      )
    )
      throw new BadRequestException(
        'That plan price is unavailable or misconfigured',
      );
    const email = (await this.repo.accountEmail(accountId)).data;
    if (!email) throw new NotFoundException('Account not found');
    const existing = await this.subscriptionFor(accountId);
    if (existing && isLive(existing.status) && existing.plan_id !== 'free')
      throw new BadRequestException(
        'You already have a plan — use “Manage billing” to change it',
      );
    const base = returnBase();
    const { url, sessionId } = await this.provider.createCheckout({
      accountId,
      email,
      customerId: existing?.customer_id ?? null,
      priceId,
      successUrl: `${base}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${base}/billing/cancel`,
      trialDays: trialDays(),
    });
    this.logger.info('Checkout started', { accountId, planId, interval });
    // Persist recovery before synchronizing either instant provider.
    const pending = await this.repo.setPendingSession(
      accountId,
      sessionId,
      this.provider.name,
    );
    if (pending.error)
      throw new InternalServerErrorException('Could not save checkout');
    if (this.provider.instantCheckout)
      await this.syncAccount(accountId, notifications);
    return { url };
  }

  async closeAccount(accountId: string): Promise<void> {
    return this.withAccount(accountId, () => this.cancelAccount(accountId));
  }

  private async cancelAccount(accountId: string): Promise<void> {
    const row = await this.subscriptionFor(accountId);
    if (!row) return;
    if (row.provider !== this.provider.name)
      throw new BadRequestException(
        'Restore the original billing provider before closing this account.',
      );
    await this.provider.closeAccount({
      accountId,
      customerId: row.customer_id || undefined,
      pendingSessionId: row.pending_session_id || undefined,
    });
    const result = await this.repo.upsert({
      ...row,
      plan_id: 'free',
      status: 'canceled',
      cancel_at_period_end: false,
      pending_session_id: null,
    });
    if (result.error)
      throw new InternalServerErrorException(
        'Could not save billing cancellation. Retry account closure.',
      );
  }

  async portal(accountId: string): Promise<{ url: string }> {
    const row = await this.subscriptionFor(accountId);
    if (!row?.customer_id)
      throw new BadRequestException('No billing account yet');
    const url = await this.provider.portalUrl(
      row.customer_id,
      `${returnBase()}/billing/return`,
    );
    return { url };
  }

  /** Re-pull from the provider (after a checkout return, or when a webhook was missed). */
  async sync(accountId: string): Promise<BillingMe> {
    return this.withAccount(accountId, (notifications) =>
      this.syncAccount(accountId, notifications),
    );
  }

  private async syncAccount(
    accountId: string,
    notifications: BillingNotification[],
  ): Promise<BillingMe> {
    const row = await this.subscriptionFor(accountId);
    let snap: SubscriptionSnapshot | null = null;
    let checkoutComplete = false;
    if (row?.subscription_id)
      snap = await this.provider.fetchSubscription(row.subscription_id);
    // Prefer a successor, but retain cancellation when none exists. Otherwise
    // a missed webhook would leave the old paid entitlement active forever.
    const previous = snap;
    if ((!snap || !isLive(snap.status)) && row?.customer_id)
      snap = await this.provider.fetchCustomerSubscription(row.customer_id);
    // No webhook yet (local API, missed delivery): the checkout session we
    // opened knows the customer and the subscription it created.
    if (!snap && row?.pending_session_id) {
      const session = await this.provider.fetchCheckoutSession(
        row.pending_session_id,
      );
      checkoutComplete = session?.complete ?? false;
      if (session?.subscriptionId)
        snap = await this.provider.fetchSubscription(session.subscriptionId);
      else if (session?.customerId)
        snap = await this.provider.fetchCustomerSubscription(
          session.customerId,
        );
    }
    if (!snap && this.provider instanceof MockBillingProvider) {
      const cus = this.provider.customersByAccount.get(accountId);
      if (cus) snap = await this.provider.fetchCustomerSubscription(cus);
    }
    snap ??= previous;
    if (snap) {
      if (snap.accountId && snap.accountId !== accountId)
        throw new BadRequestException(
          'Subscription belongs to another account',
        );
      await this.applySnapshot(
        {
          ...snap,
          accountId: snap.accountId ?? accountId,
        },
        notifications,
      );
      if (row?.pending_session_id && checkoutComplete) {
        const cleared = await this.repo.setPendingSession(accountId, null);
        if (cleared.error)
          throw new ServiceUnavailableException(
            'Could not save checkout synchronization',
          );
      }
    }
    return this.me(accountId);
  }

  // ── Webhooks ────────────────────────────────────────────────────────────
  async handleWebhook(
    rawBody: Buffer,
    signature: string | undefined,
  ): Promise<{ handled: string }> {
    let event: BillingEvent;
    try {
      event = await this.provider.parseWebhook(rawBody, signature);
    } catch (err) {
      throw new BadRequestException(
        `Webhook rejected: ${(err as Error).message}`,
      );
    }
    if (event.type === 'ignored') return { handled: 'ignored' };
    const accountId = await this.eventAccount(event);
    return this.withAccount(accountId, async (notifications) => {
      if ((await this.eventAccount(event)) !== accountId)
        throw new ServiceUnavailableException(
          'Billing event ownership changed; retry',
        );
      const claimed = await this.repo.claimEvent(
        event.id,
        this.provider.name,
        event.type,
      );
      if (claimed.error)
        throw new ServiceUnavailableException('Could not claim billing event');
      if (!claimed.data) return { handled: 'duplicate' };
      await this.applyEvent(event, accountId, notifications);
      const recorded = await this.repo.recordEvent(
        event.id,
        this.provider.name,
        event.type,
        accountId,
        event,
      );
      if (recorded.error)
        throw new ServiceUnavailableException(
          'Could not complete billing event',
        );
      return { handled: event.type };
    });
  }

  private async eventAccount(
    event: Exclude<BillingEvent, { type: 'ignored' }>,
  ): Promise<string> {
    if (event.type !== 'payment.failed' && event.subscription.accountId)
      return event.subscription.accountId;
    const customerId =
      event.type === 'payment.failed'
        ? event.customerId
        : event.subscription.customerId;
    const result = await this.repo.byCustomer(customerId);
    if (result.error || !result.data)
      throw new ServiceUnavailableException(
        'Could not resolve billing event account',
      );
    this.matchingProvider(result.data);
    return result.data.account_id;
  }

  /** Keep receipt/projection atomic and serialize observers of the same account.
   * Email is deliberately outside the database transaction, after durable success.
   */
  private async withAccount<T>(
    accountId: string,
    work: (notifications: BillingNotification[]) => Promise<T>,
  ): Promise<T> {
    const notifications: BillingNotification[] = [];
    const result = await this.repo.forAccount(accountId, () =>
      work(notifications),
    );
    for (const { accountId: recipient, message } of notifications)
      await this.notify(recipient, message);
    return result;
  }

  /** Apply one normalized event; returns the account it touched. */
  private async applyEvent(
    event: BillingEvent,
    expectedAccountId: string,
    notifications: BillingNotification[],
  ): Promise<string | null> {
    let accountId: string | null = null;
    switch (event.type) {
      case 'subscription.changed':
      case 'subscription.deleted': {
        // Deliveries are not ordered; for a live subscription prefer the
        // provider's current state over the payload's.
        const fresh =
          event.type === 'subscription.changed'
            ? await this.provider.fetchSubscription(
                event.subscription.subscriptionId,
              )
            : null;
        const base = fresh
          ? {
              ...fresh,
              accountId: fresh.accountId ?? event.subscription.accountId,
            }
          : event.subscription;
        let snap =
          event.type === 'subscription.deleted'
            ? { ...base, status: 'canceled' as const }
            : base;
        // A terminal event can arrive after the customer has subscribed again.
        // Resolve the successor before writing the account's single projection.
        const stored = await this.subscriptionFor(expectedAccountId);
        if (
          !isLive(snap.status) ||
          (stored?.subscription_id &&
            stored.subscription_id !== snap.subscriptionId)
        ) {
          const successor = await this.provider.fetchCustomerSubscription(
            snap.customerId,
          );
          if (successor && successor.subscriptionId !== snap.subscriptionId)
            snap = {
              ...successor,
              accountId: successor.accountId ?? snap.accountId,
            };
        }
        if (snap.accountId && snap.accountId !== expectedAccountId)
          throw new ServiceUnavailableException(
            'Subscription account differs from event owner',
          );
        accountId = await this.applySnapshot(
          { ...snap, accountId: expectedAccountId },
          notifications,
        );
        break;
      }
      case 'payment.failed': {
        // An invoice names its subscription. Never fall back to the customer's
        // replacement subscription when that identity is no longer current.
        // A standalone invoice is not evidence about any subscription.
        if (!event.subscriptionId) break;
        const found = await this.repo.bySubscription(event.subscriptionId);
        if (found.error)
          throw new ServiceUnavailableException(
            'Could not resolve payment subscription',
          );
        const row = this.matchingProvider(found.data);
        if (row && row.account_id !== expectedAccountId)
          throw new ServiceUnavailableException(
            'Payment subscription ownership changed',
          );
        if (row && isLive(row.status)) {
          accountId = row.account_id;
          // Invoice events can be delayed until after payment recovered. Read
          // the subscription now instead of replaying a historical failure.
          const current = await this.provider.fetchSubscription(
            row.subscription_id!,
          );
          if (!current)
            throw new ServiceUnavailableException(
              'Payment subscription is unavailable',
            );
          if (current.accountId && current.accountId !== expectedAccountId)
            throw new ServiceUnavailableException(
              'Payment subscription ownership changed',
            );
          await this.applySnapshot(
            { ...current, accountId: expectedAccountId },
            notifications,
          );
          if (current.status === 'past_due' && row.status !== 'past_due') {
            this.logger.warn('Payment failed', { accountId });
            notifications.push({
              accountId,
              message: paymentFailedEmail(planById(row.plan_id).name),
            });
          }
        }
        break;
      }
      case 'ignored':
        break;
    }
    return accountId;
  }

  /** Write a normalized subscription to the account it belongs to. Returns the account id. */
  private async applySnapshot(
    snap: SubscriptionSnapshot,
    notifications: BillingNotification[],
  ): Promise<string | null> {
    let accountId = snap.accountId;
    if (!accountId) {
      const result = await this.repo.byCustomer(snap.customerId);
      if (result.error)
        throw new ServiceUnavailableException(
          'Could not resolve subscription account',
        );
      accountId = result.data?.account_id ?? null;
    }
    if (!accountId) {
      this.logger.warn('Subscription for unknown account', {
        subscriptionId: snap.subscriptionId,
      });
      throw new ServiceUnavailableException(
        'Subscription account is unresolved',
      );
    }
    const mapped = snap.priceId ? this.priceMap.get(snap.priceId) : undefined;
    if (!mapped && snap.status !== 'canceled')
      throw new ServiceUnavailableException(
        'Subscription price is not configured',
      );
    const planId =
      snap.status === 'canceled' ? 'free' : (mapped?.planId ?? 'free');
    const before = await this.subscriptionFor(accountId);
    const r = await this.repo.upsert({
      account_id: accountId,
      provider: this.provider.name,
      customer_id: snap.customerId,
      subscription_id: snap.subscriptionId,
      plan_id: planId,
      price_id: snap.priceId,
      interval: mapped?.interval ?? null,
      status: snap.status,
      current_period_start: snap.currentPeriodStart,
      current_period_end: snap.currentPeriodEnd,
      cancel_at_period_end: snap.cancelAtPeriodEnd,
      trial_end: snap.trialEnd,
      past_due_since:
        snap.status === 'past_due'
          ? before?.subscription_id === snap.subscriptionId
            ? (before.past_due_since ?? new Date())
            : new Date()
          : null,
    });
    if (r.error)
      throw new InternalServerErrorException('Could not save subscription');
    this.logger.info('Subscription applied', {
      accountId,
      planId,
      status: snap.status,
    });
    const beforePlan = effectivePlanId(before);
    const afterPlan = effectivePlanId(r.data);
    if (beforePlan !== afterPlan) {
      const message = planChangedEmail(
        planById(beforePlan).name,
        planById(afterPlan).name,
        snap.currentPeriodEnd,
      );
      notifications.push({ accountId, message });
    }
    return accountId;
  }

  private async notify(
    accountId: string,
    msg: { subject: string; body: string },
  ): Promise<void> {
    if (this.provider.name === 'simulation') return;
    try {
      const email = (await this.repo.accountEmail(accountId)).data;
      if (email) await this.email.send({ email, ...msg });
    } catch (err) {
      this.logger.error(`billing email failed: ${(err as Error).message}`);
    }
  }

  private async subscriptionFor(
    accountId: string,
  ): Promise<SubscriptionRow | null> {
    const result = await this.repo.byAccount(accountId);
    if (result.error)
      throw new ServiceUnavailableException(
        'Subscription status is unavailable.',
      );
    return this.matchingProvider(result.data);
  }

  /** Never reinterpret simulated entitlements as real billing (or overwrite real records). */
  private matchingProvider(
    row: SubscriptionRow | null,
  ): SubscriptionRow | null {
    if (
      row &&
      row.provider !== this.provider.name &&
      (row.provider === 'simulation' || this.provider.name === 'simulation')
    )
      throw new ServiceUnavailableException(
        'Billing provider differs from stored subscription; use a separate simulation database',
      );
    return row;
  }

  async simulate(
    accountId: string,
    action: SimulationAction,
    planId?: string,
    interval?: BillingInterval,
  ): Promise<BillingMe> {
    if (!(this.provider instanceof SimulationBillingProvider))
      throw new BadRequestException('Billing simulation is not enabled');
    const provider = this.provider;
    return this.withAccount(accountId, async (notifications) => {
      await this.subscriptionFor(accountId);
      const priceId =
        action === 'change_plan'
          ? [...this.priceMap].find(
              ([, p]) => p.planId === planId && p.interval === interval,
            )?.[0]
          : undefined;
      if (action === 'change_plan' && !priceId)
        throw new BadRequestException('Choose an available plan and interval');
      const next = await provider.change(accountId, action, priceId);
      await this.applySnapshot(next, notifications);
      return this.me(accountId);
    });
  }

  async listAll(): Promise<Record<string, unknown>[]> {
    return ((await this.repo.list()).data ?? []).map((r) =>
      toEntityFields(r as unknown as Record<string, unknown>),
    );
  }
}

// ── helpers ───────────────────────────────────────────────────────────────

function isLive(status: string): boolean {
  return status === 'active' || status === 'trialing' || status === 'past_due';
}

/** Plan in force: live → plan; past_due → plan for a grace week; else free. */
export function effectivePlanId(
  row: SubscriptionRow | null | undefined,
  now = new Date(),
): string {
  if (!row) return 'free';
  if (row.status === 'active' || row.status === 'trialing') return row.plan_id;
  if (row.status === 'past_due') {
    const since = new Date(row.past_due_since ?? row.updated).getTime();
    return now.getTime() - since <= PAST_DUE_GRACE_DAYS * 86_400_000
      ? row.plan_id
      : 'free';
  }
  return 'free';
}

function trialDays(): number {
  return Math.max(0, parseInt(process.env.STRIPE_TRIAL_DAYS || '0', 10) || 0);
}

function returnBase(): string {
  return (process.env.BILLING_RETURN_URL || 'https://crux.garden').replace(
    /\/$/,
    '',
  );
}

/** STRIPE_PRICE_<PLAN>_<INTERVAL> env → price map. Mock mode gets synthetic ids. */
export function priceMapFromEnv(
  mock = false,
): Map<string, { planId: PaidPlanId; interval: BillingInterval }> {
  const m = new Map<
    string,
    { planId: PaidPlanId; interval: BillingInterval }
  >();
  const pairs: [PaidPlanId, BillingInterval, string][] = [
    ['gardener', 'month', 'STRIPE_PRICE_GARDENER_MONTHLY'],
    ['gardener', 'year', 'STRIPE_PRICE_GARDENER_YEARLY'],
    ['gardener_plus', 'month', 'STRIPE_PRICE_GARDENER_PLUS_MONTHLY'],
    ['gardener_plus', 'year', 'STRIPE_PRICE_GARDENER_PLUS_YEARLY'],
  ];
  const testPrices = process.env.STRIPE_USE_GARDENER_TEST_PRICES === '1';
  if (testPrices && !process.env.STRIPE_SECRET_KEY?.startsWith('sk_test_'))
    throw new Error('Gardener test prices require a Stripe test key.');
  const suppliedTestIds = [
    'price_0UFcNylLTquvz3Ep5Unmm6th',
    'price_0UFcP3lLTquvz3Ep0wwokR7y',
    'price_0UFcPllLTquvz3EpxSSwY84B',
    'price_0UFcQ6lLTquvz3EpSM2HD4si',
  ];
  const anyEnv = pairs.some(([, , k]) => !!process.env[k]);
  for (const [index, [planId, interval, key]] of pairs.entries()) {
    const id =
      process.env[key] ||
      (testPrices
        ? suppliedTestIds[index]
        : mock && !anyEnv
          ? `price_mock_${planId}_${interval}`
          : '');
    if (
      id &&
      suppliedTestIds.includes(id) &&
      !process.env.STRIPE_SECRET_KEY?.startsWith('sk_test_')
    )
      throw new Error(
        'A supplied test price cannot be used with live Stripe billing.',
      );
    if (id) m.set(id, { planId, interval });
  }
  return m;
}
