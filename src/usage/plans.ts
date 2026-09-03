/**
 * Plans: what an account is allowed. Reported, not enforced (V1 §9-A); the
 * subscription system will enforce and add billing anchors.
 */
export interface Plan {
  id: string;
  name: string;
  /** bytes of published storage */
  storageBytes: number;
  /** bytes of bandwidth per billing period */
  bandwidthBytesPerPeriod: number;
}

const GB = 1024 * 1024 * 1024;

export const PLANS: Record<string, Plan> = {
  free: {
    id: 'free',
    name: 'Free',
    storageBytes: 1 * GB,
    bandwidthBytesPerPeriod: 1 * GB,
  },
};

export const DEFAULT_PLAN_ID = 'free';

export function planFor(
  meta: Record<string, unknown> | null | undefined,
): Plan {
  const id = typeof meta?.plan === 'string' ? meta.plan : DEFAULT_PLAN_ID;
  return PLANS[id] ?? PLANS[DEFAULT_PLAN_ID];
}

/** Billing period = the UTC calendar month containing `now`. */
export function billingPeriod(now = new Date()): {
  start: string;
  end: string;
} {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const start = new Date(Date.UTC(y, m, 1));
  const end = new Date(Date.UTC(y, m + 1, 1));
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  };
}
