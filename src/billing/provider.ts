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
  trialEnd: Date | null;
  /** accountId we stamped on the subscription/checkout, when present */
  accountId: string | null;
}

export type BillingEvent =
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
}

export interface BillingProvider {
  readonly name: string;
  createCheckout(
    req: CheckoutRequest,
  ): Promise<{ url: string; sessionId: string }>;
  portalUrl(customerId: string, returnUrl: string): Promise<string>;
  /** Verify and normalize a webhook. Throws on a bad signature. */
  parseWebhook(
    rawBody: Buffer,
    signature: string | undefined,
  ): Promise<BillingEvent>;
  /** Pull the current state of a subscription (re-sync after checkout, admin repair). */
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
  /** the session finished and payment (or trial) is in place */
  complete: boolean;
}

export class MockBillingProvider implements BillingProvider {
  readonly name = 'mock';
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
    const end = new Date(now.getTime() + 30 * 86_400_000);
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
      complete: true,
    });
    return {
      url: `${req.successUrl.replace('{CHECKOUT_SESSION_ID}', sessionId)}`,
      sessionId,
    };
  }
  async fetchCheckoutSession(sessionId: string) {
    return this.sessions.get(sessionId) ?? null;
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
        (s) => s.customerId === customerId && s.status !== 'canceled',
      ) ?? null
    );
  }
  async prices(priceIds: string[]) {
    return priceIds.map(
      (id) =>
        this.mockPrices[id] ?? {
          priceId: id,
          amount: id.includes('year') ? 5000 : 500,
          currency: 'usd',
          interval: id.includes('year')
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
