import { BadRequestException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { RepositoryResponse } from '../common/types/interfaces';
import { BillingSimulationRepository } from './simulation.repository';
import {
  MockBillingProvider,
  type BillingProvider,
  type CheckoutRequest,
  type CheckoutSessionInfo,
  type SubscriptionSnapshot,
  type BillingEvent,
} from './provider';

function unwrap<T>(result: RepositoryResponse<T>): T {
  if (result.error) throw result.error;
  return result.data;
}
function snapshot(
  value: SubscriptionSnapshot | null,
): SubscriptionSnapshot | null {
  if (!value) return null;
  return {
    ...value,
    currentPeriodStart: value.currentPeriodStart
      ? new Date(value.currentPeriodStart)
      : null,
    currentPeriodEnd: value.currentPeriodEnd
      ? new Date(value.currentPeriodEnd)
      : null,
    trialEnd: value.trialEnd ? new Date(value.trialEnd) : null,
  };
}

export const SIMULATION_ACTIONS = [
  'activate',
  'payment_failed',
  'unpaid',
  'cancel',
  'cancel_at_period_end',
  'renew',
  'change_plan',
] as const;
export type SimulationAction = (typeof SIMULATION_ACTIONS)[number];

/** Persistent provider confined to the configured API database. Makes no network calls. */
export class SimulationBillingProvider implements BillingProvider {
  readonly name = 'simulation';
  readonly instantCheckout = true;
  private readonly mock = new MockBillingProvider();
  constructor(private readonly repo: BillingSimulationRepository) {}

  async createCheckout(req: CheckoutRequest) {
    const interval = (await this.prices([req.priceId]))[0].interval;
    const { sessionId } = unwrap(
      await this.repo.checkout(req.accountId, (customerId, current) => {
        if (req.customerId && req.customerId !== customerId)
          throw new BadRequestException(
            'Customer belongs to another billing provider or account',
          );
        if (
          current &&
          ['active', 'trialing', 'past_due'].includes(current.status)
        )
          throw new BadRequestException(
            'A simulated subscription is already active',
          );
        const now = new Date();
        const end = new Date(now);
        if (interval === 'year') end.setUTCFullYear(end.getUTCFullYear() + 1);
        else end.setUTCMonth(end.getUTCMonth() + 1);
        return {
          customerId,
          subscriptionId: `sub_sim_${randomUUID()}`,
          accountId: req.accountId,
          priceId: req.priceId,
          status: req.trialDays > 0 ? 'trialing' : 'active',
          currentPeriodStart: now,
          currentPeriodEnd: end,
          cancelAtPeriodEnd: false,
          trialEnd:
            req.trialDays > 0
              ? new Date(now.getTime() + req.trialDays * 86_400_000)
              : null,
        };
      }),
    );
    return {
      sessionId,
      url: req.successUrl.replace(
        '{CHECKOUT_SESSION_ID}',
        encodeURIComponent(sessionId),
      ),
    };
  }
  async fetchCheckoutSession(id: string) {
    return unwrap(await this.repo.read<CheckoutSessionInfo>('session', id));
  }
  async expireCheckout(id: string) {
    const session = await this.fetchCheckoutSession(id);
    if (!session) throw new BadRequestException('Checkout session not found');
    return session; // simulation completes inside its transaction; no open external checkout
  }
  async fetchSubscription(id: string) {
    return snapshot(
      unwrap(await this.repo.read<SubscriptionSnapshot>('subscription', id)),
    );
  }
  async fetchCustomerSubscription(id: string) {
    const customer = unwrap(
      await this.repo.read<{ subscriptionId: string | null }>('customer', id),
    );
    return customer?.subscriptionId
      ? this.fetchSubscription(customer.subscriptionId)
      : null;
  }
  async change(
    accountId: string,
    action: SimulationAction,
    priceId?: string,
  ): Promise<SubscriptionSnapshot> {
    if (!SIMULATION_ACTIONS.includes(action))
      throw new BadRequestException('Unknown simulation action');
    return unwrap(
      await this.repo.change(accountId, (stored) => {
        const current = snapshot(stored);
        if (current.status === 'canceled')
          throw new BadRequestException(
            'Start a new simulated checkout after cancellation',
          );
        switch (action) {
          case 'change_plan':
            if (!priceId)
              throw new BadRequestException('A simulation price is required');
            return { ...current, priceId };
          case 'activate':
            return {
              ...current,
              status: 'active',
              trialEnd: null,
              cancelAtPeriodEnd: false,
            };
          case 'payment_failed':
            return { ...current, status: 'past_due' };
          case 'unpaid':
            return { ...current, status: 'unpaid' };
          case 'cancel':
            return {
              ...current,
              status: 'canceled',
              cancelAtPeriodEnd: false,
              trialEnd: null,
            };
          case 'cancel_at_period_end':
            return { ...current, cancelAtPeriodEnd: true };
          case 'renew': {
            if (current.cancelAtPeriodEnd)
              return {
                ...current,
                status: 'canceled',
                cancelAtPeriodEnd: false,
                trialEnd: null,
              };
            const start = current.currentPeriodEnd ?? new Date();
            const end = new Date(start);
            if (current.priceId?.endsWith('_year'))
              end.setUTCFullYear(end.getUTCFullYear() + 1);
            else end.setUTCMonth(end.getUTCMonth() + 1);
            return {
              ...current,
              status: 'active',
              trialEnd: null,
              currentPeriodStart: start,
              currentPeriodEnd: end,
            };
          }
        }
      }),
    );
  }
  prices(ids: string[]) {
    return this.mock.prices(ids);
  }
  async closeAccount(input: { accountId: string; customerId?: string }) {
    if (
      !input.customerId ||
      !(await this.fetchCustomerSubscription(input.customerId))
    )
      return;
    unwrap(
      await this.repo.change(input.accountId, (current) => ({
        ...current,
        status: 'canceled',
        cancelAtPeriodEnd: false,
      })),
    );
  }
  async portalUrl(): Promise<string> {
    throw new BadRequestException(
      'Use simulation controls to manage simulated billing',
    );
  }
  async parseWebhook(rawBody: Buffer): Promise<BillingEvent> {
    void rawBody;
    throw new BadRequestException(
      'External webhooks are disabled for simulated billing',
    );
  }
}
