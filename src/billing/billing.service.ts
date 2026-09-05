import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
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
import { stripeProviderFromEnv } from './stripe.provider';
import {
  PLANS,
  PLAN_ORDER,
  planById,
  type BillingInterval,
  type PaidPlanId,
  type Plan,
} from '../usage/plans';

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
  ) {
    this.logger = loggerService.createChildLogger('BillingService');
    const stripe = stripeProviderFromEnv();
    this.provider = stripe ?? new MockBillingProvider();
    if (!stripe)
      this.logger.warn(
        'Billing in MOCK mode — STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET not set; checkouts succeed instantly',
      );
    this.priceMap = priceMapFromEnv();
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
    return effectivePlanId(r.data, now);
  }

  async me(accountId: string, now = new Date()): Promise<BillingMe> {
    const row = (await this.repo.byAccount(accountId)).data;
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
      canManage: !!row?.customer_id,
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
          return p
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
      instant: this.provider.name === 'mock',
    };
  }

  // ── Checkout / portal ───────────────────────────────────────────────────
  async checkout(
    accountId: string,
    planId: string,
    interval: BillingInterval,
  ): Promise<{ url: string }> {
    const entry = [...this.priceMap.entries()].find(
      ([, v]) => v.planId === planId && v.interval === interval,
    );
    if (!entry) throw new BadRequestException('That plan is not available');
    const [priceId] = entry;
    const email = (await this.repo.accountEmail(accountId)).data;
    if (!email) throw new NotFoundException('Account not found');
    const existing = (await this.repo.byAccount(accountId)).data;
    if (existing && isLive(existing.status) && existing.plan_id !== 'free')
      throw new BadRequestException(
        'You already have a plan — use “Manage billing” to change it',
      );
    const base = returnBase();
    const { url } = await this.provider.createCheckout({
      accountId,
      email,
      customerId: existing?.customer_id ?? null,
      priceId,
      successUrl: `${base}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${base}/billing/cancel`,
      trialDays: trialDays(),
    });
    this.logger.info('Checkout started', { accountId, planId, interval });
    // Mock provider: the "payment" already happened — reflect it now.
    if (this.provider.name === 'mock') await this.sync(accountId);
    return { url };
  }

  async portal(accountId: string): Promise<{ url: string }> {
    const row = (await this.repo.byAccount(accountId)).data;
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
    const row = (await this.repo.byAccount(accountId)).data;
    let snap: SubscriptionSnapshot | null = null;
    if (row?.subscription_id)
      snap = await this.provider.fetchSubscription(row.subscription_id);
    // A canceled subscription says nothing about a newer one on the same customer
    if (snap && (snap.status === 'canceled' || snap.status === 'incomplete'))
      snap = null;
    if (!snap && row?.customer_id)
      snap = await this.provider.fetchCustomerSubscription(row.customer_id);
    if (!snap && this.provider instanceof MockBillingProvider) {
      const cus = this.provider.customersByAccount.get(accountId);
      if (cus) snap = await this.provider.fetchCustomerSubscription(cus);
    }
    if (snap)
      await this.applySnapshot({
        ...snap,
        accountId: snap.accountId ?? accountId,
      });
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
    const claimed = await this.repo.claimEvent(
      event.id,
      this.provider.name,
      event.type,
    );
    if (!claimed.data) return { handled: 'duplicate' };
    let accountId: string | null = null;
    try {
      accountId = await this.applyEvent(event);
    } catch (err) {
      await this.repo.releaseEvent(event.id);
      throw err;
    }
    await this.repo.recordEvent(
      event.id,
      this.provider.name,
      event.type,
      accountId,
      event,
    );
    return { handled: event.type };
  }

  /** Apply one normalized event; returns the account it touched. */
  private async applyEvent(event: BillingEvent): Promise<string | null> {
    let accountId: string | null = null;
    switch (event.type) {
      case 'subscription.changed':
      case 'subscription.deleted': {
        // Deliveries are not ordered; for a live subscription prefer the
        // provider's current state over the payload's.
        const fresh =
          event.type === 'subscription.changed'
            ? await this.provider
                .fetchSubscription(event.subscription.subscriptionId)
                .catch(() => null)
            : null;
        const base = fresh
          ? {
              ...fresh,
              accountId: fresh.accountId ?? event.subscription.accountId,
            }
          : event.subscription;
        const snap =
          event.type === 'subscription.deleted'
            ? { ...base, status: 'canceled' as const }
            : base;
        accountId = await this.applySnapshot(snap);
        break;
      }
      case 'payment.failed': {
        const row =
          (event.subscriptionId &&
            (await this.repo.bySubscription(event.subscriptionId)).data) ||
          (await this.repo.byCustomer(event.customerId)).data;
        if (row) {
          accountId = row.account_id;
          const firstFailure = row.status !== 'past_due';
          await this.repo.upsert({
            ...stripUpdated(row),
            status: 'past_due',
            // the grace clock starts once; retries do not restart it
            past_due_since: row.past_due_since ?? new Date(),
          });
          this.logger.warn('Payment failed', { accountId });
          if (firstFailure)
            await this.notify(
              accountId,
              paymentFailedEmail(planById(row.plan_id).name),
            );
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
  ): Promise<string | null> {
    let accountId = snap.accountId;
    if (!accountId) {
      const byCus = (await this.repo.byCustomer(snap.customerId)).data;
      accountId = byCus?.account_id ?? null;
    }
    if (!accountId) {
      this.logger.warn('Subscription for unknown account', {
        subscriptionId: snap.subscriptionId,
      });
      return null;
    }
    const mapped = snap.priceId ? this.priceMap.get(snap.priceId) : undefined;
    const planId =
      snap.status === 'canceled' ? 'free' : (mapped?.planId ?? 'free');
    const before = (await this.repo.byAccount(accountId)).data;
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
          ? (before?.past_due_since ?? new Date())
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
    if (beforePlan !== afterPlan)
      await this.notify(
        accountId,
        planChangedEmail(
          planById(beforePlan).name,
          planById(afterPlan).name,
          snap.currentPeriodEnd,
        ),
      );
    return accountId;
  }

  private async notify(
    accountId: string,
    msg: { subject: string; body: string },
  ): Promise<void> {
    try {
      const email = (await this.repo.accountEmail(accountId)).data;
      if (email) await this.email.send({ email, ...msg });
    } catch (err) {
      this.logger.error(`billing email failed: ${(err as Error).message}`);
    }
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

function stripUpdated(row: SubscriptionRow): Omit<SubscriptionRow, 'updated'> {
  const rest: Partial<SubscriptionRow> = { ...row };
  delete rest.updated;
  return rest as Omit<SubscriptionRow, 'updated'>;
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
function priceMapFromEnv(): Map<
  string,
  { planId: PaidPlanId; interval: BillingInterval }
> {
  const m = new Map<
    string,
    { planId: PaidPlanId; interval: BillingInterval }
  >();
  const pairs: [PaidPlanId, BillingInterval, string][] = [
    ['gardener', 'month', 'STRIPE_PRICE_GARDENER_MONTHLY'],
    ['gardener', 'year', 'STRIPE_PRICE_GARDENER_YEARLY'],
  ];
  const anyEnv = pairs.some(([, , k]) => !!process.env[k]);
  for (const [planId, interval, key] of pairs) {
    const id =
      process.env[key] || (!anyEnv ? `price_mock_${planId}_${interval}` : '');
    if (id) m.set(id, { planId, interval });
  }
  return m;
}
