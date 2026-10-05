import type { BillingInterval } from '../usage/plans';

/**
 * The seam between Crux Garden and a payment provider (ADR 0012). Stripe is
 * the adapter in production; the mock runs tests and the local nursery. The
 * service only ever sees these shapes — never a vendor payload.
 */
export type SubscriptionStatus =
  | 'none'
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'incomplete'
  /** the first payment never completed; nothing started, checkout may run again */
  | 'incomplete_expired'
  | 'unpaid';

/** What we know about a subscription, normalized. */
export interface SubscriptionSnapshot {
  customerId: string;
  subscriptionId: string;
  priceId: string | null;
  status: SubscriptionStatus;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  /** a scheduled cancellation date (Stripe `cancel_at`), when one is set */
  cancelAt?: Date | null;
  trialEnd: Date | null;
  /** accountId we stamped on the subscription/checkout, when present */
  accountId: string | null;
}

export type BillingEvent =
  | {
      id: string;
      type: 'checkout.completed';
      accountId: string | null;
      customerId: string;
      subscriptionId: string;
    }
  | {
      id: string;
      type: 'subscription.changed';
      subscription: SubscriptionSnapshot;
    }
  | {
      id: string;
      type: 'subscription.deleted';
      subscription: SubscriptionSnapshot;
    }
  | {
      id: string;
      type: 'payment.failed';
      customerId: string;
      subscriptionId: string | null;
    }
  | { id: string; type: 'ignored'; raw: string };

export interface CheckoutRequest {
  /** Persisted before external creation; required by the Stripe adapter. */
  idempotencyKey?: string;
  accountId: string;
  email: string;
  /** existing provider customer, so a returning account never gets a second one */
  customerId: string | null;
  priceId: string;
  successUrl: string;
  cancelUrl: string;
  trialDays: number;
}

export interface PriceInfo {
  priceId: string;
  amount: number; // minor units
  currency: string;
  interval: BillingInterval;
  /** how the provider treats tax on this price, when it says */
  taxBehavior?: 'exclusive' | 'inclusive' | 'unspecified';
}

/** One invoice, normalized for Settings and the account-closure email. */
export interface InvoiceSummary {
  id: string;
  number: string | null;
  /** ISO timestamp the invoice was created */
  date: string;
  totalCents: number;
  currency: string;
  status: string;
  hostedUrl: string | null;
  pdfUrl: string | null;
}

/** How many invoices Settings and the closure email carry. */
export const INVOICE_LIMIT = 24;

export interface BillingProvider {
  readonly name: string;
  readonly instantCheckout?: boolean;
  /** the provider computes tax at checkout (Stripe Tax) */
  readonly automaticTax?: boolean;
  createCheckout(
    req: CheckoutRequest,
  ): Promise<{ url: string; sessionId: string }>;
  portalUrl(customerId: string, returnUrl: string): Promise<string>;
  /** Most recent invoices first, at most `limit`. A customer the provider no
   * longer has returns []; unavailability throws. */
  invoices(customerId: string, limit: number): Promise<InvoiceSummary[]>;
  /** Has this customer ever had a subscription that started? A second guard
   * for trial eligibility beside local records; omitted means "unknown". */
  hasSubscriptionHistory?(customerId: string): Promise<boolean>;
  /** Stop billing and pending checkout before an account is closed: cancel any
   * live subscription immediately (no refund) and remove the customer. Must be
   * retryable. Capture invoices first — they may be unreachable afterwards. */
  closeAccount(input: {
    accountId: string;
    customerId?: string;
    pendingSessionId?: string;
  }): Promise<void>;
  /** Verify and normalize without network calls. Provider enrichment belongs
   * after durable receipt deduplication, inside monitored event processing.
   * Throws on a bad signature.
   */
  parseWebhook(
    rawBody: Buffer,
    signature: string | undefined,
  ): Promise<BillingEvent>;
  /** Pull current state. Return null only for confirmed absence; unavailability throws. */
  fetchSubscription(
    subscriptionId: string,
  ): Promise<SubscriptionSnapshot | null>;
  /** Find a customer's live subscription by customer id (used right after checkout). */
  fetchCustomerSubscription(
    customerId: string,
  ): Promise<SubscriptionSnapshot | null>;
  /**
   * What a checkout session produced — the customer and subscription ids once
   * it completed. Lets sync recover an account whose webhook never arrived.
   */
  fetchCheckoutSession(sessionId: string): Promise<CheckoutSessionInfo | null>;
  /** Expire an open session and return its confirmed state; never cancels a paid plan. */
  expireCheckout(sessionId: string): Promise<CheckoutSessionInfo>;
  /** Amounts for the catalog. */
  prices(priceIds: string[]): Promise<PriceInfo[]>;
}

/**
 * In-memory provider: checkout "succeeds" immediately (the URL points at the
 * success page and the subscription exists when the app re-syncs). Tests drive
 * webhooks by calling `emit`.
 */
export interface CheckoutSessionInfo {
  customerId: string | null;
  subscriptionId: string | null;
  status: 'open' | 'complete' | 'expired';
  accountId: string | null;
  attemptId: string | null;
  url: string | null;
}

export class MockBillingProvider implements BillingProvider {
  readonly name = 'mock';
  readonly instantCheckout = true;
  subscriptions = new Map<string, SubscriptionSnapshot>();
  customersByAccount = new Map<string, string>();
  /** sessionId → what it produced (the mock completes checkout instantly) */
  sessions = new Map<string, CheckoutSessionInfo>();
  private n = 0;
  /** queued events for parseWebhook (tests) */
  queue: BillingEvent[] = [];
  mockPrices: Record<string, PriceInfo> = {};

  async createCheckout(req: CheckoutRequest) {
    const customerId = req.customerId ?? `cus_mock_${++this.n}`;
    this.customersByAccount.set(req.accountId, customerId);
    const subscriptionId = `sub_mock_${++this.n}`;
    const now = new Date();
    const interval = (await this.prices([req.priceId]))[0].interval;
    const end = new Date(now);
    if (interval === 'year') end.setFullYear(end.getFullYear() + 1);
    else end.setMonth(end.getMonth() + 1);
    this.subscriptions.set(subscriptionId, {
      customerId,
      subscriptionId,
      priceId: req.priceId,
      status: req.trialDays > 0 ? 'trialing' : 'active',
      currentPeriodStart: now,
      currentPeriodEnd: end,
      cancelAtPeriodEnd: false,
      trialEnd:
        req.trialDays > 0
          ? new Date(now.getTime() + req.trialDays * 86_400_000)
          : null,
      accountId: req.accountId,
    });
    const sessionId = `cs_mock_${this.n}`;
    this.sessions.set(sessionId, {
      customerId,
      subscriptionId,
      status: 'complete',
      accountId: req.accountId,
      attemptId: req.idempotencyKey ?? null,
      url: req.successUrl.replace('{CHECKOUT_SESSION_ID}', sessionId),
    });
    return {
      url: `${req.successUrl.replace('{CHECKOUT_SESSION_ID}', sessionId)}`,
      sessionId,
    };
  }
  async fetchCheckoutSession(sessionId: string) {
    return this.sessions.get(sessionId) ?? null;
  }
  async expireCheckout(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('Checkout session not found');
    if (session.status === 'open') {
      session.status = 'expired';
      session.url = null;
    }
    return session;
  }
  async closeAccount(input: {
    accountId: string;
    customerId?: string;
    pendingSessionId?: string;
  }) {
    for (const [id, subscription] of this.subscriptions) {
      if (
        subscription.accountId === input.accountId ||
        subscription.customerId === input.customerId
      )
        this.subscriptions.set(id, {
          ...subscription,
          status: 'canceled',
          cancelAtPeriodEnd: false,
        });
    }
  }
  /** test fixture: invoices by customer id, newest first */
  mockInvoices = new Map<string, InvoiceSummary[]>();
  async invoices(customerId: string, limit: number) {
    return (this.mockInvoices.get(customerId) ?? []).slice(0, limit);
  }
  async hasSubscriptionHistory(customerId: string) {
    return [...this.subscriptions.values()].some(
      (s) =>
        s.customerId === customerId &&
        !['none', 'incomplete', 'incomplete_expired'].includes(s.status),
    );
  }
  async portalUrl(customerId: string, returnUrl: string) {
    return `https://billing.mock/portal/${customerId}?return=${encodeURIComponent(returnUrl)}`;
  }
  async parseWebhook(rawBody: Buffer): Promise<BillingEvent> {
    const queued = this.queue.shift();
    if (queued) return queued;
    return {
      id: `evt_${++this.n}`,
      type: 'ignored',
      raw: rawBody.toString('utf8').slice(0, 40),
    };
  }
  async fetchSubscription(id: string) {
    return this.subscriptions.get(id) ?? null;
  }
  async fetchCustomerSubscription(customerId: string) {
    return (
      [...this.subscriptions.values()].find(
        (s) =>
          s.customerId === customerId &&
          s.status !== 'canceled' &&
          s.status !== 'incomplete_expired',
      ) ?? null
    );
  }
  async prices(priceIds: string[]) {
    return priceIds.map(
      (id) =>
        this.mockPrices[id] ?? {
          priceId: id,
          amount:
            (id.includes('year') || id.endsWith('_y') ? 10000 : 1000) *
            (id.includes('gardener_plus') ? 2 : 1),
          currency: 'usd',
          interval:
            id.includes('year') || id.endsWith('_y')
              ? ('year' as const)
              : ('month' as const),
        },
    );
  }
  /** test helper */
  emit(ev: BillingEvent) {
    this.queue.push(ev);
  }
}
