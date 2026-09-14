import { priceMapFromEnv } from './billing.service';
import { MockBillingProvider } from './provider';
describe('Gardener test billing configuration', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    for (const key of Object.keys(process.env))
      if (key.startsWith('STRIPE_')) delete process.env[key];
  });
  afterEach(() => {
    process.env = { ...saved };
  });
  it('never synthesizes prices for a real billing provider', () =>
    expect(priceMapFromEnv().size).toBe(0));
  it('uses all four supplied IDs only after explicit test opt-in', () => {
    process.env.STRIPE_USE_GARDENER_TEST_PRICES = '1';
    process.env.STRIPE_SECRET_KEY = 'sk_test_fixture';
    expect([...priceMapFromEnv().entries()]).toEqual([
      [
        'price_0UFcNylLTquvz3Ep5Unmm6th',
        { planId: 'gardener', interval: 'month' },
      ],
      [
        'price_0UFcP3lLTquvz3Ep0wwokR7y',
        { planId: 'gardener', interval: 'year' },
      ],
      [
        'price_0UFcPllLTquvz3EpxSSwY84B',
        { planId: 'gardener_plus', interval: 'month' },
      ],
      [
        'price_0UFcQ6lLTquvz3EpSM2HD4si',
        { planId: 'gardener_plus', interval: 'year' },
      ],
    ]);
    process.env.STRIPE_SECRET_KEY = 'sk_live_fixture';
    expect(() => priceMapFromEnv()).toThrow('test key');
  });
  it('rejects a supplied test price configured through a live environment field', () => {
    process.env.STRIPE_SECRET_KEY = 'sk_live_fixture';
    process.env.STRIPE_PRICE_GARDENER_MONTHLY =
      'price_0UFcNylLTquvz3Ep5Unmm6th';
    expect(() => priceMapFromEnv()).toThrow('test price');
  });
  it('represents the new monthly and annual prices in mock mode', async () => {
    const prices = await new MockBillingProvider().prices([
      ...priceMapFromEnv(true).keys(),
    ]);
    expect(prices.map((p) => p.amount)).toEqual([1000, 10000, 2000, 20000]);
  });
});

describe('Stripe catalogue accuracy', () => {
  it('omits inactive, unknown-amount and unsupported recurring prices instead of showing $0 or a false monthly interval', async () => {
    const { StripeBillingProvider } = await import('./stripe.provider');
    const rows: Record<string, unknown> = {
      good: {
        id: 'good',
        active: true,
        unit_amount: 1000,
        currency: 'usd',
        recurring: { interval: 'month', interval_count: 1 },
      },
      unknown: {
        id: 'unknown',
        active: true,
        unit_amount: null,
        currency: 'usd',
        recurring: { interval: 'month', interval_count: 1 },
      },
      weekly: {
        id: 'weekly',
        active: true,
        unit_amount: 1000,
        currency: 'usd',
        recurring: { interval: 'week', interval_count: 1 },
      },
      inactive: {
        id: 'inactive',
        active: false,
        unit_amount: 1000,
        currency: 'usd',
        recurring: { interval: 'month', interval_count: 1 },
      },
    };
    const provider = new StripeBillingProvider(
      { prices: { retrieve: async (id: string) => rows[id] } } as never,
      'fixture',
      false,
    );
    expect(await provider.prices(Object.keys(rows))).toEqual([
      { priceId: 'good', amount: 1000, currency: 'usd', interval: 'month' },
    ]);
  });
});
