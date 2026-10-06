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
    const canceled = new Set<string>();
    const cancel = jest.fn(async (id: string) => {
      canceled.add(id);
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
      subscriptions: {
        list: jest.fn(async ({ customer }: { customer: string }) => ({
          data:
            customer === 'customer'
              ? [
                  {
                    id: 'sub_live',
                    status: canceled.has('sub_live') ? 'canceled' : 'active',
                  },
                  { id: 'sub_old', status: 'canceled' },
                  { id: 'sub_never', status: 'incomplete_expired' },
                ]
              : [],
        })),
        cancel,
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
    // The live subscription is canceled explicitly, immediately, without proration.
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith('sub_live', {
      invoice_now: false,
      prorate: false,
    });
    retrieve.mockResolvedValue({
      id: 'session',
      status: 'expired',
      client_reference_id: 'account',
      customer: 'pending-customer',
    });
    await provider.closeAccount(input);
    expect(remove).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('lists recent invoices with their links and treats a removed customer as none', async () => {
    const list = jest.fn().mockResolvedValueOnce({
      data: [
        {
          id: 'in_2',
          number: 'CG-0002',
          created: 1_790_000_000,
          total: 1000,
          currency: 'usd',
          status: 'paid',
          hosted_invoice_url: 'https://invoice.stripe.com/i/2',
          invoice_pdf: 'https://pay.stripe.com/invoice/2/pdf',
        },
        {
          id: 'in_draft',
          number: null,
          created: 1_790_000_100,
          total: 1000,
          currency: 'usd',
          status: 'draft',
          hosted_invoice_url: null,
          invoice_pdf: null,
        },
      ],
    });
    list.mockRejectedValueOnce(
      Object.assign(new Error('No such customer'), {
        code: 'resource_missing',
        statusCode: 404,
      }),
    );
    list.mockRejectedValueOnce(new Error('network'));
    const provider = new StripeBillingProvider(
      { invoices: { list } } as unknown as Stripe,
      'unused',
      false,
    );
    expect(await provider.invoices('cus_1', 24)).toEqual([
      {
        id: 'in_2',
        number: 'CG-0002',
        date: new Date(1_790_000_000 * 1000).toISOString(),
        totalCents: 1000,
        currency: 'usd',
        status: 'paid',
        hostedUrl: 'https://invoice.stripe.com/i/2',
        pdfUrl: 'https://pay.stripe.com/invoice/2/pdf',
      },
    ]);
    expect(list).toHaveBeenCalledWith({ customer: 'cus_1', limit: 24 });
    expect(await provider.invoices('cus_gone', 24)).toEqual([]);
    await expect(provider.invoices('cus_1', 24)).rejects.toThrow('network');
  });

  it('knows whether a customer ever had a subscription that started', async () => {
    const list = jest
      .fn()
      .mockResolvedValueOnce({
        data: [{ status: 'incomplete_expired' }, { status: 'incomplete' }],
      })
      .mockResolvedValueOnce({ data: [{ status: 'canceled' }] });
    const provider = new StripeBillingProvider(
      { subscriptions: { list } } as unknown as Stripe,
      'unused',
      false,
    );
    expect(await provider.hasSubscriptionHistory('cus_1')).toBe(false);
    expect(await provider.hasSubscriptionHistory('cus_1')).toBe(true);
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
