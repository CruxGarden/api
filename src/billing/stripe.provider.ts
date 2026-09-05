import Stripe from 'stripe';
import type {
  BillingEvent,
  BillingProvider,
  CheckoutRequest,
  PriceInfo,
  SubscriptionSnapshot,
  SubscriptionStatus,
} from './provider';

/**
 * Stripe adapter. Checkout is Stripe's hosted page (cards, Link, Apple Pay,
 * Google Pay — the frictionless part), the Customer Portal handles changes and
 * cancellation, webhooks carry state back. Nothing here is imported by the
 * service directly; it comes in through `BillingProvider`.
 */
export class StripeBillingProvider implements BillingProvider {
  readonly name = 'stripe';
  constructor(
    private readonly stripe: Stripe,
    private readonly webhookSecret: string,
    private readonly automaticTax: boolean,
  ) {}

  async createCheckout(req: CheckoutRequest) {
    const session = await this.stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: req.priceId, quantity: 1 }],
      ...(req.customerId
        ? {
            customer: req.customerId,
            customer_update: { address: 'auto', name: 'auto' },
          }
        : { customer_email: req.email }),
      client_reference_id: req.accountId,
      success_url: req.successUrl,
      cancel_url: req.cancelUrl,
      allow_promotion_codes: true,
      billing_address_collection: 'auto',
      automatic_tax: { enabled: this.automaticTax },
      subscription_data: {
        metadata: { accountId: req.accountId },
        ...(req.trialDays > 0
          ? {
              trial_period_days: req.trialDays,
              // card-free trial: when it ends without a payment method, end it — never
              // leave a paused subscription that reads as a paid plan
              trial_settings: {
                end_behavior: { missing_payment_method: 'cancel' as const },
              },
            }
          : {}),
      },
      // A card-free trial when trials are on; otherwise collect up front.
      payment_method_collection: req.trialDays > 0 ? 'if_required' : 'always',
      metadata: { accountId: req.accountId },
    });
    if (!session.url) throw new Error('Stripe did not return a checkout URL');
    return { url: session.url, sessionId: session.id };
  }

  async portalUrl(customerId: string, returnUrl: string) {
    const s = await this.stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
    });
    return s.url;
  }

  async parseWebhook(
    rawBody: Buffer,
    signature: string | undefined,
  ): Promise<BillingEvent> {
    if (!signature) throw new Error('Missing stripe-signature header');
    const event = this.stripe.webhooks.constructEvent(
      rawBody,
      signature,
      this.webhookSecret,
    );
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const subId =
          typeof session.subscription === 'string'
            ? session.subscription
            : session.subscription?.id;
        if (!subId) return { id: event.id, type: 'ignored', raw: event.type };
        const sub = await this.stripe.subscriptions.retrieve(subId);
        return {
          id: event.id,
          type: 'subscription.changed',
          subscription: snapshot(sub, session.client_reference_id ?? undefined),
        };
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.paused':
      case 'customer.subscription.resumed':
      case 'customer.subscription.trial_will_end':
        return {
          id: event.id,
          type: 'subscription.changed',
          subscription: snapshot(event.data.object),
        };
      case 'customer.subscription.deleted':
        return {
          id: event.id,
          type: 'subscription.deleted',
          subscription: snapshot(event.data.object),
        };
      case 'invoice.payment_failed': {
        const inv = event.data.object;
        const customerId =
          typeof inv.customer === 'string' ? inv.customer : inv.customer?.id;
        // API 2025-08-27+: the subscription lives under invoice.parent; older
        // shapes had invoice.subscription. Read both.
        const parentSub = (
          inv as unknown as {
            parent?: {
              subscription_details?: {
                subscription?: string | { id: string } | null;
              } | null;
            } | null;
          }
        ).parent?.subscription_details?.subscription;
        const legacySub = (
          inv as unknown as { subscription?: string | { id: string } | null }
        ).subscription;
        const subField = parentSub ?? legacySub;
        const subscriptionId =
          typeof subField === 'string' ? subField : (subField?.id ?? null);
        return {
          id: event.id,
          type: 'payment.failed',
          customerId: customerId ?? '',
          subscriptionId,
        };
      }
      default:
        return { id: event.id, type: 'ignored', raw: event.type };
    }
  }

  async fetchSubscription(subscriptionId: string) {
    try {
      const sub = await this.stripe.subscriptions.retrieve(subscriptionId);
      return snapshot(sub);
    } catch {
      return null;
    }
  }

  async fetchCustomerSubscription(customerId: string) {
    const list = await this.stripe.subscriptions.list({
      customer: customerId,
      status: 'all',
      limit: 10,
    });
    const live = list.data
      .filter(
        (s) => s.status !== 'canceled' && s.status !== 'incomplete_expired',
      )
      .sort((a, b) => b.created - a.created)[0];
    return live ? snapshot(live) : null;
  }

  async fetchCheckoutSession(sessionId: string) {
    const s = await this.stripe.checkout.sessions.retrieve(sessionId);
    const id = (v: string | { id: string } | null | undefined) =>
      typeof v === 'string' ? v : (v?.id ?? null);
    return {
      customerId: id(s.customer),
      subscriptionId: id(s.subscription),
      complete: s.status === 'complete',
    };
  }

  async prices(priceIds: string[]): Promise<PriceInfo[]> {
    const out: PriceInfo[] = [];
    for (const id of priceIds) {
      try {
        const p = await this.stripe.prices.retrieve(id);
        out.push({
          priceId: p.id,
          amount: p.unit_amount ?? 0,
          currency: p.currency,
          interval: p.recurring?.interval === 'year' ? 'year' : 'month',
        });
      } catch {
        /* a missing price just isn't offered */
      }
    }
    return out;
  }
}

function status(s: Stripe.Subscription.Status): SubscriptionStatus {
  switch (s) {
    case 'trialing':
    case 'active':
    case 'past_due':
    case 'canceled':
    case 'unpaid':
      return s;
    case 'incomplete':
    case 'incomplete_expired':
      return 'incomplete';
    case 'paused':
      // a trial that ended without a card: no entitlement
      return 'none';
    default:
      return 'none';
  }
}

/** Normalize a Stripe subscription; period fields moved onto items in newer API versions. */
function snapshot(
  sub: Stripe.Subscription,
  accountIdHint?: string,
): SubscriptionSnapshot {
  const item = sub.items?.data?.[0];
  const legacy = sub as unknown as {
    current_period_start?: number;
    current_period_end?: number;
  };
  const start =
    legacy.current_period_start ??
    (item as unknown as { current_period_start?: number })
      ?.current_period_start;
  const end =
    legacy.current_period_end ??
    (item as unknown as { current_period_end?: number })?.current_period_end;
  return {
    customerId:
      typeof sub.customer === 'string' ? sub.customer : sub.customer.id,
    subscriptionId: sub.id,
    priceId: item?.price?.id ?? null,
    status: status(sub.status),
    currentPeriodStart: start ? new Date(start * 1000) : null,
    currentPeriodEnd: end ? new Date(end * 1000) : null,
    cancelAtPeriodEnd: !!sub.cancel_at_period_end,
    trialEnd: sub.trial_end ? new Date(sub.trial_end * 1000) : null,
    accountId: sub.metadata?.accountId || accountIdHint || null,
  };
}

/** From env: Stripe when configured, else null (the module falls back to the mock). */
export function stripeProviderFromEnv(): StripeBillingProvider | null {
  const key = process.env.STRIPE_SECRET_KEY;
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!key || !secret) return null;
  return new StripeBillingProvider(
    new Stripe(key),
    secret,
    process.env.STRIPE_AUTOMATIC_TAX === '1',
  );
}
