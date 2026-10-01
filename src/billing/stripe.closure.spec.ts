import Stripe from 'stripe';
import { StripeBillingProvider } from './stripe.provider';

describe('Stripe account closure', () => {
  it('expires pending checkout, closes both known customers, and is safe to retry', async () => {
    const retrieve = jest.fn().mockResolvedValue({
      id: 'session',
      status: 'open',
      client_reference_id: 'account',
      customer: 'pending-customer',
    });
    const expire = jest.fn().mockResolvedValue({
      id: 'session',
      status: 'expired',
      customer: 'pending-customer',
    });
    const deleted = new Set<string>();
    const remove = jest.fn(async (id: string) => {
      deleted.add(id);
    });
    const stripe = {
      checkout: { sessions: { retrieve, expire } },
      customers: {
        retrieve: jest.fn(async (id: string) => ({
          id,
          deleted: deleted.has(id),
        })),
        del: remove,
      },
    } as unknown as Stripe;
    const provider = new StripeBillingProvider(stripe, 'unused', false);
    const input = {
      accountId: 'account',
      customerId: 'customer',
      pendingSessionId: 'session',
    };
    await provider.closeAccount(input);
    expect(expire).toHaveBeenCalledWith('session');
    expect(deleted).toEqual(new Set(['customer', 'pending-customer']));
    retrieve.mockResolvedValue({
      id: 'session',
      status: 'expired',
      client_reference_id: 'account',
      customer: 'pending-customer',
    });
    await provider.closeAccount(input);
    expect(remove).toHaveBeenCalledTimes(2);
  });
  it('refuses another account checkout before canceling anything', async () => {
    const remove = jest.fn();
    const stripe = {
      checkout: {
        sessions: {
          retrieve: jest
            .fn()
            .mockResolvedValue({ client_reference_id: 'other' }),
        },
      },
      customers: { del: remove },
    } as unknown as Stripe;
    await expect(
      new StripeBillingProvider(stripe, 'unused', false).closeAccount({
        accountId: 'account',
        pendingSessionId: 'session',
      }),
    ).rejects.toThrow('different account');
    expect(remove).not.toHaveBeenCalled();
  });
});
