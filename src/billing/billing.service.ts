import {
  type NoticeCondition,
  BillingOperationsRepository,
} from './operations.repository';
import { operationResult, billingFailureCode } from './operations';
import {
  reserveCheckout,
  resumeCheckout as resumePendingCheckout,
  cancelCheckout as cancelPendingCheckout,
  requireOpenAccount,
  recoverCheckout as recoverPendingCheckout,
} from './checkout-attempts';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { LoggerService } from '../common/services/logger.service';
import { toEntityFields } from '../common/helpers/case-helpers';
import { EmailService } from '../common/services/email.service';
import {
  accountClosedEmail,
  paymentFailedEmail,
  planChangedEmail,
} from './billing.emails';
import { BillingRepository, type SubscriptionRow } from './billing.repository';
import {
  INVOICE_LIMIT,
  MockBillingProvider,
  type InvoiceSummary,
  type BillingEvent,
  type BillingProvider,
  type PriceInfo,
  type SubscriptionSnapshot,
  type CheckoutRequest,
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
import { ALLOWANCES, EFFORT } from '../inference/policy';

interface BillingNotification {
  accountId: string;
  message: { subject: string; body: string };
  condition?: NoticeCondition;
  /** one notice per key, ever (retried closures must not resend) */
  dedupeKey?: string;
  /** address captured now; the account may be closed before delivery */
  recipient?: string;
}

/** The refusal every hosted write gives a suspended account (ADR 0083). */
export const ACCOUNT_SUSPENDED_MESSAGE =
  'This account is suspended. Contact support.';

/** Something the customer must do about billing; null when nothing is owed. */
export interface BillingAttention {
  kind: 'payment_failed' | 'payment_incomplete' | 'unpaid';
  message: string;
  /** where the fix happens: the provider portal, or a fresh checkout */
  action: 'portal' | 'checkout';
}

/** What the app shows on Settings → Plan. */
export interface BillingMe {
  plan: Plan;
  status: string;
  interval: BillingInterval | null;
  renewsAt: string | null;
  /** true whenever a cancellation is scheduled (period end or a `cancel_at` date) */
  cancelAtPeriodEnd: boolean;
  /** when a scheduled cancellation ends the plan; null when it renews */
  endsAt: string | null;
  trialEndsAt: string | null;
  graceEndsAt: string | null;
  /** a payment problem the customer can act on */
  attention: BillingAttention | null;
  /** a checkout now would include the free trial (trials on, never subscribed) */
  trialEligible: boolean;
  pendingCheckout: boolean;
  /** the account has a provider customer → the portal can be opened */
  canManage: boolean;
  provider: string;
}

/** What a paid tier includes of hosted collaboration (inference/policy.ts). */
export interface IncludedCollaboration {
  fiveHourMicrodollars: number;
  thirtyDayMicrodollars: number;
  effort: 'low' | 'medium' | 'high';
}

export type TaxBehavior = 'exclusive' | 'inclusive' | 'automatic';

export interface CatalogPlan {
  plan: Plan;
  /** null for Free */
  includedCollaboration: IncludedCollaboration | null;
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
  /** null: prices are shown as-is, no tax collected at checkout */
  taxBehavior: TaxBehavior | null;
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
    @Optional() private readonly operations?: BillingOperationsRepository,
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
    const attempt = await this.repo.checkoutAttempt(accountId);
    if (attempt.error)
      throw new ServiceUnavailableException('Checkout status is unavailable');
    const pendingCheckout =
      !isLive(row?.status ?? 'none') &&
      (!!row?.pending_session_id ||
        (!!attempt.data &&
          ['preparing', 'open'].includes(attempt.data.status)));
    const endsAt = scheduledEnd(row);
    return {
      pendingCheckout,
      plan: planById(planId),
      status: row?.status ?? 'none',
      interval: (row?.interval as BillingInterval | null) ?? null,
      renewsAt: row?.current_period_end
        ? new Date(row.current_period_end).toISOString()
        : null,
      cancelAtPeriodEnd: !!endsAt,
      endsAt: endsAt?.toISOString() ?? null,
      trialEndsAt: row?.trial_end
        ? new Date(row.trial_end).toISOString()
        : null,
      graceEndsAt: graceDeadline(row)?.toISOString() ?? null,
      attention: attentionFor(row),
      trialEligible: trialDays() > 0 && !row?.subscription_started_at,
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
      includedCollaboration: includedCollaboration(id),
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
      taxBehavior: this.taxBehavior(
        plans.flatMap((p) => p.prices.map((price) => byId.get(price.priceId))),
      ),
      provider: this.provider.name,
      instant: !!this.provider.instantCheckout,
    };
  }

  /**
   * How the app should describe tax beside a price. Only Stripe Tax collects
   * tax at checkout; then the prices' own tax behavior decides "plus tax" or
   * "includes tax", and `STRIPE_TAX_BEHAVIOR` overrides an unspecified price.
   */
  private taxBehavior(prices: (PriceInfo | undefined)[]): TaxBehavior | null {
    if (!this.provider.automaticTax) return null;
    const configured = process.env.STRIPE_TAX_BEHAVIOR;
    if (configured === 'exclusive' || configured === 'inclusive')
      return configured;
    const behaviors = new Set(
      prices.map((p) => p?.taxBehavior ?? 'unspecified'),
    );
    if (behaviors.size === 1) {
      const [only] = behaviors;
      if (only === 'exclusive' || only === 'inclusive') return only;
    }
    return 'automatic';
  }

  // ── Suspension (ADR 0083) ───────────────────────────────────────────────
  /**
   * Refuse hosted writes for a suspended account: publish, sync push, checkout,
   * included inference, Store and Function writes. Fails closed when the hold
   * cannot be read. Sign-in, reads and export are never gated here.
   */
  async assertNotSuspended(
    accountId: string | null | undefined,
  ): Promise<void> {
    if (!accountId) return;
    const result = await this.repo.accountSuspension(accountId);
    if (result.error)
      throw new ServiceUnavailableException('Account status is unavailable');
    if (result.data?.suspended)
      throw new ForbiddenException(ACCOUNT_SUSPENDED_MESSAGE);
  }

  /** The same refusal, for routes that know only the owning author. */
  async assertAuthorNotSuspended(
    authorId: string | null | undefined,
  ): Promise<void> {
    if (!authorId) return;
    const result = await this.repo.authorSuspension(authorId);
    if (result.error)
      throw new ServiceUnavailableException('Account status is unavailable');
    if (result.data?.suspended)
      throw new ForbiddenException(ACCOUNT_SUSPENDED_MESSAGE);
  }

  // ── Checkout / portal ───────────────────────────────────────────────────
  async checkout(
    accountId: string,
    planId: string,
    interval: BillingInterval,
  ): Promise<{ url: string }> {
    // Commit provider observations even when the requested purchase is refused.
    // Validation below still runs under the account lock against that projection.
    await this.sync(accountId);
    if (this.provider.instantCheckout)
      return this.withAccount(accountId, async (notifications) => {
        const request = await this.checkoutRequest(accountId, planId, interval);
        const result = await this.provider.createCheckout(request);
        const pending = await this.repo.setPendingSession(
          accountId,
          result.sessionId,
          this.provider.name,
        );
        if (pending.error)
          throw new ServiceUnavailableException('Could not save checkout');
        await this.syncAccount(accountId, notifications);
        return { url: result.url };
      });
    // Commit the intent before any external checkout creation. The second account
    // transaction can roll back its result without losing the provider retry key.
    await this.withAccount(accountId, async () => {
      const request = await this.checkoutRequest(accountId, planId, interval);
      await reserveCheckout(this.repo, this.provider, request);
    });
    return this.resumeCheckout(accountId);
  }

  async resumeCheckout(accountId: string): Promise<{ url: string }> {
    await this.assertNotSuspended(accountId);
    return this.withAccount(accountId, async () => {
      const result = await resumePendingCheckout(
        this.repo,
        this.provider,
        accountId,
      );
      return { url: result.url };
    });
  }

  async cancelCheckout(accountId: string): Promise<BillingMe> {
    return this.withAccount(accountId, async (notifications) => {
      await cancelPendingCheckout(this.repo, this.provider, accountId);
      return this.syncAccount(accountId, notifications);
    });
  }

  async recoverCheckout(
    accountId: string,
    sessionId: string,
  ): Promise<BillingMe> {
    return this.withAccount(accountId, async (notifications) => {
      await recoverPendingCheckout(
        this.repo,
        this.provider,
        accountId,
        sessionId,
      );
      this.logger.info('Checkout recovered by operator', {
        accountId,
        sessionId,
      });
      return this.syncAccount(accountId, notifications);
    });
  }

  /** A local missing result is never proof of provider absence. Only an admin's
   * documented provider review can release an old ambiguous attempt. */
  async resolveAbsentCheckout(
    accountId: string,
    attemptId: string,
    operatorId: string,
    reviewReference: string,
  ) {
    if (!this.operations)
      throw new ServiceUnavailableException(
        'Billing recovery audit is unavailable',
      );
    return this.withAccount(accountId, async () => {
      const attempt = operationResult(
        await this.repo.checkoutAttempt(accountId),
      );
      const row = operationResult(await this.repo.byAccount(accountId));
      if (
        !attempt ||
        attempt.id !== attemptId ||
        attempt.provider !== this.provider.name ||
        attempt.status !== 'preparing' ||
        attempt.session_id ||
        Date.now() - new Date(attempt.created_at).getTime() <
          23 * 60 * 60_000 ||
        row?.pending_session_id ||
        (row?.subscription_id && row.status !== 'canceled')
      )
        throw new BadRequestException(
          'Only the exact old ambiguous checkout can be resolved as absent',
        );
      operationResult(
        await this.operations!.recordAbsentCheckout(
          attemptId,
          accountId,
          operatorId,
          this.provider.name,
          reviewReference,
        ),
      );
      operationResult(
        await this.repo.saveCheckoutAttempt({ ...attempt, status: 'expired' }),
      );
      this.logger.info('Operator resolved provider-reviewed absent checkout', {
        accountId,
        attemptId,
        operatorId,
      });
      return this.me(accountId);
    });
  }

  private async checkoutRequest(
    accountId: string,
    planId: string,
    interval: BillingInterval,
  ): Promise<CheckoutRequest> {
    await requireOpenAccount(this.repo, accountId);
    await this.assertNotSuspended(accountId);
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
    const emailResult = await this.repo.accountEmail(accountId);
    if (emailResult.error)
      throw new ServiceUnavailableException('Account is unavailable');
    const email = emailResult.data;
    if (!email) throw new NotFoundException('Account not found');
    const existing = await this.subscriptionFor(accountId);
    if (existing?.subscription_id) {
      // An invoice is owed: paying it restores the plan; a second subscription
      // would charge twice.
      if (existing.status === 'unpaid' || existing.status === 'incomplete')
        throw new ConflictException(OWED_MESSAGE);
      if (!CHECKOUT_AGAIN.has(existing.status))
        throw new BadRequestException(
          'You already have a plan — use “Manage billing” to change it',
        );
    }
    const base = returnBase();
    return {
      accountId,
      email,
      customerId: existing?.customer_id ?? null,
      priceId,
      successUrl: `${base}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${base}/billing/cancel`,
      trialDays: await this.eligibleTrialDays(existing),
    };
  }

  /**
   * A trial only for an account that never had a subscription start — local
   * history first, then the provider's own record of the reused customer.
   * Decided before the request is persisted, so a retried checkout is identical.
   */
  private async eligibleTrialDays(
    row: SubscriptionRow | null,
  ): Promise<number> {
    const days = trialDays();
    if (!days || row?.subscription_started_at) return 0;
    if (row?.customer_id && this.provider.hasSubscriptionHistory) {
      if (await this.provider.hasSubscriptionHistory(row.customer_id)) return 0;
    }
    return days;
  }

  async closeAccount(accountId: string): Promise<void> {
    // Commit the fence before external cleanup. If cleanup fails, another
    // checkout cannot start while AccountService retries the remaining closure.
    await this.repo.forAccount(accountId, async () => {
      const closing = await this.repo.markClosing(accountId);
      if (closing.error)
        throw new ServiceUnavailableException(
          'Could not start account closure',
        );
    });
    return this.withAccount(accountId, (notifications) =>
      this.cancelAccount(accountId, notifications),
    );
  }

  /**
   * Cancel immediately (no refund: the account is going away) after capturing
   * the invoice links the customer needs afterwards. The provider removes the
   * customer, so invoices are read first and mailed with the closure notice.
   */
  private async cancelAccount(
    accountId: string,
    notifications: BillingNotification[],
  ): Promise<void> {
    await cancelPendingCheckout(this.repo, this.provider, accountId);
    const row = await this.subscriptionFor(accountId);
    if (!row) return;
    if (row.provider !== this.provider.name)
      throw new BadRequestException(
        'Restore the original billing provider before closing this account.',
      );
    let invoices: InvoiceSummary[] = [];
    let recipient: string | null = null;
    if (row.customer_id) {
      invoices = await this.provider.invoices(row.customer_id, INVOICE_LIMIT);
      const email = await this.repo.accountEmail(accountId);
      if (email.error)
        throw new ServiceUnavailableException('Account is unavailable');
      recipient = email.data;
    }
    // Any subscription that still exists ends now, including one that owes an invoice.
    const endedPlan =
      row.subscription_id &&
      row.status !== 'none' &&
      !CHECKOUT_AGAIN.has(row.status)
        ? row.plan_id
        : 'free';
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
    if (recipient)
      notifications.push({
        accountId,
        recipient,
        dedupeKey: `account-closed:${accountId}`,
        message: accountClosedEmail(
          endedPlan === 'free' ? null : planById(endedPlan).name,
          invoices,
        ),
      });
  }

  /** The account's most recent invoices (at most 24), newest first. */
  async invoices(accountId: string): Promise<InvoiceSummary[]> {
    const row = await this.subscriptionFor(accountId);
    if (!row?.customer_id || row.provider !== this.provider.name) return [];
    try {
      return await this.provider.invoices(row.customer_id, INVOICE_LIMIT);
    } catch (error) {
      this.logger.warn('Invoice list unavailable', {
        accountId,
        error: (error as Error).message,
      });
      throw new ServiceUnavailableException('Invoices are unavailable');
    }
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
    let checkoutStatus: 'open' | 'complete' | 'expired' | null = null;
    if (row?.subscription_id) {
      snap = await this.provider.fetchSubscription(row.subscription_id);
      // A confirmed missing subscription must not leave its old paid projection alive.
      if (!snap) snap = canceledSnapshot(row);
    }
    // Prefer a successor, but retain cancellation when none exists. Otherwise
    // a missed webhook would leave the old paid entitlement active forever.
    const previous = snap;
    if ((!snap || !isLive(snap.status)) && row?.customer_id)
      snap = await this.provider.fetchCustomerSubscription(row.customer_id);
    // No webhook yet (local API, missed delivery): the checkout session we
    // opened knows the customer and the subscription it created.
    if (row?.pending_session_id) {
      const session = await this.provider.fetchCheckoutSession(
        row.pending_session_id,
      );
      if (session && session.accountId !== accountId)
        throw new BadRequestException('Checkout belongs to another account');
      checkoutStatus = session?.status ?? null;
      if ((!snap || !isLive(snap.status)) && session?.subscriptionId)
        snap = await this.provider.fetchSubscription(session.subscriptionId);
      else if ((!snap || !isLive(snap.status)) && session?.customerId)
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
    }
    if (
      row?.pending_session_id &&
      (checkoutStatus === 'complete' || checkoutStatus === 'expired')
    ) {
      const attempt = await this.repo.checkoutAttempt(accountId);
      if (attempt.error)
        throw new ServiceUnavailableException('Could not read checkout status');
      if (attempt.data?.session_id === row.pending_session_id) {
        const saved = await this.repo.saveCheckoutAttempt({
          ...attempt.data,
          status: checkoutStatus === 'complete' ? 'completed' : 'expired',
        });
        if (saved.error)
          throw new ServiceUnavailableException(
            'Could not save checkout status',
          );
      }
      const cleared = await this.repo.setPendingSession(accountId, null);
      if (cleared.error)
        throw new ServiceUnavailableException(
          'Could not save checkout synchronization',
        );
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
    try {
      const result = await this.processEvent(event);
      if (this.operations)
        operationResult(
          await this.operations.delivery(
            event.id,
            this.provider.name,
            event.type,
            null,
          ),
        );
      return result;
    } catch (error) {
      if (this.operations) {
        const recorded = await this.operations.delivery(
          event.id,
          this.provider.name,
          event.type,
          billingFailureCode(error),
        );
        if (recorded.error)
          this.logger.error(
            'Billing delivery monitoring unavailable',
            undefined,
            {
              eventId: event.id,
            },
          );
      }
      throw error;
    }
  }

  private async processEvent(
    event: Exclude<BillingEvent, { type: 'ignored' }>,
  ): Promise<{ handled: string }> {
    const completed = await this.repo.eventCompleted(
      event.id,
      this.provider.name,
    );
    if (completed.error)
      throw new ServiceUnavailableException('Could not read billing receipt');
    if (completed.data) return { handled: 'duplicate' };
    const accountId = await this.eventAccount(event);
    return this.withAccount(
      accountId,
      async (notifications, closed) => {
        if ((await this.eventAccount(event)) !== accountId)
          throw new ServiceUnavailableException(
            'Billing event ownership changed; retry',
          );
        if (closed) await this.requireClosedOwner(event, accountId);
        const claimed = await this.repo.claimEvent(
          event.id,
          this.provider.name,
          event.type,
        );
        if (claimed.error)
          throw new ServiceUnavailableException(
            'Could not claim billing event',
          );
        if (!claimed.data) return { handled: 'duplicate' };
        if (!closed) await this.applyEvent(event, accountId, notifications);
        const recorded = await this.repo.recordEvent(
          event.id,
          this.provider.name,
          event.type,
          accountId,
          closed ? { ...event, outcome: 'account.closed' } : event,
        );
        if (recorded.error)
          throw new ServiceUnavailableException(
            'Could not complete billing event',
          );
        return { handled: closed ? 'account.closed' : event.type };
      },
      'retained',
    );
  }

  /** Closing an account retains its billing identities and committed fence.
   * Those facts, not event metadata alone, authorize a receipt without mutation.
   */
  private async requireClosedOwner(
    event: Exclude<BillingEvent, { type: 'ignored' }>,
    accountId: string,
  ): Promise<void> {
    const row = await this.subscriptionFor(accountId);
    const identity = 'subscription' in event ? event.subscription : event;
    const closing = await this.repo.isClosing(accountId);
    if (
      closing.error ||
      !closing.data ||
      !row ||
      row.provider !== this.provider.name ||
      row.status !== 'canceled' ||
      row.plan_id !== 'free' ||
      !identity.customerId ||
      !identity.subscriptionId ||
      row.customer_id !== identity.customerId ||
      row.subscription_id !== identity.subscriptionId
    )
      throw new ServiceUnavailableException(
        'Closed billing owner could not be verified',
      );
  }

  private async eventAccount(
    event: Exclude<BillingEvent, { type: 'ignored' }>,
  ): Promise<string> {
    if ('subscription' in event && event.subscription.accountId)
      return event.subscription.accountId;
    if (event.type === 'checkout.completed' && event.accountId)
      return event.accountId;
    const customerId =
      'subscription' in event
        ? event.subscription.customerId
        : event.customerId;
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
    work: (notifications: BillingNotification[], closed: boolean) => Promise<T>,
    scope: 'live' | 'retained' = 'live',
  ): Promise<T> {
    const notifications: BillingNotification[] = [];
    const result = await this.repo.forAccount(
      accountId,
      async (closed) => {
        const value = await work(notifications, closed);
        if (this.operations && this.provider.name !== 'simulation') {
          for (const notice of notifications)
            operationResult(
              await this.operations.enqueue(
                notice.accountId,
                notice.message,
                notice.dedupeKey,
                notice.condition,
                notice.recipient,
              ),
            );
        }
        return value;
      },
      scope,
    );
    // Production uses the durable outbox; isolated legacy unit fixtures omit it.
    if (!this.operations)
      for (const {
        accountId: recipient,
        message,
        recipient: address,
      } of notifications)
        await this.notify(recipient, message, address);
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
      case 'checkout.completed':
      case 'subscription.changed':
      case 'subscription.deleted': {
        // Deliveries are not ordered; for a live subscription prefer the
        // provider's current state over the payload's.
        const identity = 'subscription' in event ? event.subscription : event;
        const fresh =
          event.type !== 'subscription.deleted'
            ? await this.provider.fetchSubscription(identity.subscriptionId)
            : null;
        if (
          fresh &&
          identity.customerId &&
          fresh.customerId !== identity.customerId
        )
          throw new ServiceUnavailableException(
            'Subscription customer differs from event owner',
          );
        let base: SubscriptionSnapshot;
        if (fresh)
          base = { ...fresh, accountId: fresh.accountId ?? identity.accountId };
        else if ('subscription' in event)
          base = { ...event.subscription, status: 'canceled' };
        else
          throw new ServiceUnavailableException(
            'Checkout subscription is unavailable',
          );
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
      cancel_at: snap.cancelAt ?? null,
      trial_end: snap.trialEnd,
      // Never cleared: a canceled or replaced subscription still used the trial.
      subscription_started_at:
        before?.subscription_started_at ??
        (STARTED.has(snap.status) ? new Date() : null),
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
    if (snap.status === 'past_due' && before?.status !== 'past_due') {
      this.logger.warn('Payment failed', { accountId });
      notifications.push({
        accountId,
        message: paymentFailedEmail(planById(planId).name),
        condition: { subscriptionId: snap.subscriptionId, status: 'past_due' },
      });
    }
    const beforePlan = effectivePlanId(before);
    const afterPlan = effectivePlanId(r.data);
    if (beforePlan !== afterPlan) {
      const message = planChangedEmail(
        planById(beforePlan).name,
        planById(afterPlan).name,
        snap.currentPeriodEnd,
      );
      notifications.push({
        accountId,
        message,
        condition: { subscriptionId: snap.subscriptionId, planId: afterPlan },
      });
    }
    return accountId;
  }

  private async notify(
    accountId: string,
    msg: { subject: string; body: string },
    address?: string,
  ): Promise<void> {
    if (this.provider.name === 'simulation') return;
    try {
      const email = address ?? (await this.repo.accountEmail(accountId)).data;
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
    const result = await this.repo.list();
    if (result.error)
      throw new ServiceUnavailableException('Subscription list is unavailable');
    return result.data.map((r) =>
      toEntityFields(r as unknown as Record<string, unknown>),
    );
  }
}

// ── helpers ───────────────────────────────────────────────────────────────

function isLive(status: string): boolean {
  return status === 'active' || status === 'trialing' || status === 'past_due';
}

/** Statuses that prove a subscription started (and so used any trial). */
const STARTED = new Set([
  'trialing',
  'active',
  'past_due',
  'unpaid',
  'canceled',
]);

/** Subscription states after which a new checkout may run. */
const CHECKOUT_AGAIN = new Set(['canceled', 'incomplete_expired']);

const OWED_MESSAGE =
  'Pay the outstanding invoice in Manage billing to restore your plan.';

/** What the customer must do about a payment problem, if anything. */
export function attentionFor(
  row: SubscriptionRow | null | undefined,
): BillingAttention | null {
  if (!row?.subscription_id) return null;
  switch (row.status) {
    case 'past_due':
      return {
        kind: 'payment_failed',
        message:
          'Your last payment didn’t go through. Update your payment method in Manage billing to keep your plan.',
        action: 'portal',
      };
    case 'unpaid':
      return { kind: 'unpaid', message: OWED_MESSAGE, action: 'portal' };
    case 'incomplete':
      return {
        kind: 'payment_incomplete',
        message: OWED_MESSAGE,
        action: 'portal',
      };
    case 'incomplete_expired':
      return {
        kind: 'payment_incomplete',
        message:
          'Your first payment didn’t complete, so the plan didn’t start. Choose a plan to try again.',
        action: 'checkout',
      };
    default:
      return null;
  }
}

/** When a scheduled cancellation ends a plan that is still running. */
function scheduledEnd(row: SubscriptionRow | null | undefined): Date | null {
  if (!row || !isLive(row.status)) return null;
  if (row.cancel_at) return new Date(row.cancel_at);
  if (row.cancel_at_period_end && row.current_period_end)
    return new Date(row.current_period_end);
  return null;
}

/** A paid tier's included collaboration; null for Free. */
export function includedCollaboration(
  planId: string,
): IncludedCollaboration | null {
  const allowance = ALLOWANCES[planId];
  const effort = EFFORT[planId];
  if (!allowance || !effort) return null;
  return {
    fiveHourMicrodollars: allowance.fiveHour,
    thirtyDayMicrodollars: allowance.thirtyDay,
    effort,
  };
}

/** Plan in force: live → plan; past_due → plan for a grace week; else free. */
export function effectivePlanId(
  row: SubscriptionRow | null | undefined,
  now = new Date(),
): string {
  if (!row) return 'free';
  if (row.status === 'active' || row.status === 'trialing') return row.plan_id;
  if (row.status === 'past_due') {
    const deadline = graceDeadline(row);
    return deadline && now.getTime() <= deadline.getTime()
      ? row.plan_id
      : 'free';
  }
  return 'free';
}

function graceDeadline(row: SubscriptionRow | null | undefined): Date | null {
  if (row?.status !== 'past_due') return null;
  const since = new Date(row.past_due_since ?? row.updated).getTime();
  return Number.isFinite(since)
    ? new Date(since + PAST_DUE_GRACE_DAYS * 86_400_000)
    : null;
}

function canceledSnapshot(row: SubscriptionRow): SubscriptionSnapshot {
  const date = (value: Date | string | null) =>
    value ? new Date(value) : null;
  return {
    accountId: row.account_id,
    customerId: row.customer_id ?? '',
    subscriptionId: row.subscription_id!,
    priceId: row.price_id,
    status: 'canceled',
    cancelAtPeriodEnd: false,
    cancelAt: null,
    currentPeriodStart: date(row.current_period_start),
    currentPeriodEnd: date(row.current_period_end),
    trialEnd: date(row.trial_end),
  };
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
