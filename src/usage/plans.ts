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
  /** Crux Store reads + writes per billing period */
  storeRequestsPerPeriod: number;
}

const GB = 1024 * 1024 * 1024;

export const PLANS: Record<string, Plan> = {
  free: {
    id: 'free',
    name: 'Free',
    storageBytes: 1 * GB,
    bandwidthBytesPerPeriod: 1 * GB,
    storeRequestsPerPeriod: 100_000,
  },
};

export const DEFAULT_PLAN_ID = 'free';

/**
 * How usage settles. Bandwidth comes from CloudFront logs, which arrive late and
 * can only undercount, so the customer gets the benefit of the doubt:
 * - a period is finalized only after `graceHours` past its end;
 * - enforcement (when it comes) triggers at `softLimitFactor` × the plan limit;
 * - a day whose metered bytes trail CloudFront's own count by more than
 *   `reconcileGapPct` is flagged, never silently accepted.
 */
export const SETTLEMENT = {
  graceHours: 48,
  softLimitFactor: 1.1,
  reconcileGapPct: 5,
  /** below this many edge bytes a day, percentages are noise */
  reconcileMinBytes: 1024 * 1024,
} as const;

/** The billing period before the one containing `now`. */
export function previousBillingPeriod(now = new Date()): {
  start: string;
  end: string;
} {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  return {
    start: new Date(Date.UTC(y, m - 1, 1)).toISOString().slice(0, 10),
    end: new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10),
  };
}

/** When a period's numbers stop moving, and whether that moment has passed. */
export function settlementFor(
  period: { start: string; end: string },
  now = new Date(),
): { finalizesAt: string; isFinal: boolean; graceHours: number } {
  const finalizesAt = new Date(
    new Date(`${period.end}T00:00:00Z`).getTime() +
      SETTLEMENT.graceHours * 3_600_000,
  );
  return {
    finalizesAt: finalizesAt.toISOString(),
    isFinal: now.getTime() >= finalizesAt.getTime(),
    graceHours: SETTLEMENT.graceHours,
  };
}

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
