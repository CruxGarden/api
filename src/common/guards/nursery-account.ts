import { JwtPayload } from '../types/interfaces';

/** Demo authentication must never turn a deployed API into an anonymous administrator. */
export function assertNurseryConfiguration(): void {
  if (
    process.env.NODE_ENV === 'production' &&
    process.env.NURSERY_MODE === 'true'
  ) {
    throw new Error('NURSERY_MODE cannot be enabled in production');
  }
}

export function nurseryAccount(): JwtPayload | undefined {
  assertNurseryConfiguration();
  if (process.env.NURSERY_MODE !== 'true') return undefined;
  const now = Math.floor(Date.now() / 1000);
  return {
    id: 'd7f5c645-6b4e-4c3b-a5cb-3fd81c652b96',
    email: 'keeper@crux.garden',
    role: 'keeper',
    grantId: 'nursery-mode-grant',
    exp: now + 86400,
    iat: now,
  };
}
