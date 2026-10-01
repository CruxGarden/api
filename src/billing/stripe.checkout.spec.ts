import { StripeBillingProvider } from './stripe.provider';
import type { CheckoutRequest } from './provider';

const request: CheckoutRequest = {
  idempotencyKey: 'fixed-attempt-identity',
  accountId: 'account',
  email: 'owner@example.test',
  customerId: null,
  priceId: 'price_month',
  successUrl: 'https://example.test/success',
  cancelUrl: 'https://example.test/cancel',
  trialDays: 0,
};

describe('Stripe checkout retry and expiration', () => {
  it('uses the persisted identity in provider idempotency options and recovery metadata', async () => {
    const create = jest.fn(async () => ({
      id: 'cs_test',
      url: 'https://checkout.stripe.com/cs_test',
    }));
    const provider = new StripeBillingProvider(
      { checkout: { sessions: { create } } } as never,
      'unused',
      false,
    );
    await provider.createCheckout(request);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        client_reference_id: 'account',
        metadata: { accountId: 'account', attemptId: request.idempotencyKey },
      }),
      { idempotencyKey: request.idempotencyKey },
    );
    await expect(
      provider.createCheckout({ ...request, idempotencyKey: undefined }),
    ).rejects.toThrow('durable checkout identity');
    expect(create).toHaveBeenCalledTimes(1);
  });
  it('recognizes completion during an expiration race instead of claiming cancellation', async () => {
    const retrieve = jest
      .fn()
      .mockResolvedValueOnce({
        status: 'open',
        client_reference_id: 'account',
        metadata: { attemptId: 'attempt' },
        url: 'https://checkout.stripe.com/cs_test',
      })
      .mockResolvedValue({
        status: 'complete',
        client_reference_id: 'account',
        metadata: { attemptId: 'attempt' },
        customer: 'cus_test',
        subscription: 'sub_test',
        url: null,
      });
    const expire = jest.fn().mockRejectedValue(new Error('Already completed'));
    const provider = new StripeBillingProvider(
      { checkout: { sessions: { retrieve, expire } } } as never,
      'unused',
      false,
    );
    expect(await provider.expireCheckout('cs_test')).toMatchObject({
      status: 'complete',
      accountId: 'account',
      attemptId: 'attempt',
      subscriptionId: 'sub_test',
    });
  });
});
