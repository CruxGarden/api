import { HARD_FACTOR } from '../usage/limits.service';

/**
 * What a successful publish tells the creator about their plan limits
 * (ROADMAP § Customer review, "Expected at v1 — Usage"). Limits are
 * grace-first: past the soft limit a publish still succeeds; past twice the
 * plan it is refused before this is reached.
 */
export interface PublishWarning {
  kind: 'storage_soft_limit' | 'bandwidth_soft_limit';
  message: string;
  usedBytes: number;
  limitBytes: number;
}

export interface StorageCheck {
  used: number;
  limit: number;
  softLimit: number;
  warn: boolean;
}

export function formatBytes(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(gb >= 10 ? 0 : 1)} GB`;
  return `${Math.max(0, Math.round(bytes / 1024 ** 2))} MB`;
}

/** Warnings from the storage check; an absent or malformed check yields none. */
export function publishWarnings(
  storage: StorageCheck | null | undefined,
): PublishWarning[] {
  if (
    !storage ||
    !storage.warn ||
    !Number.isFinite(storage.used) ||
    !Number.isFinite(storage.limit) ||
    storage.limit <= 0
  )
    return [];
  return [
    {
      kind: 'storage_soft_limit',
      message: `Published. You are using ${formatBytes(storage.used)} of storage, more than the ${formatBytes(storage.limit)} your plan includes. Publishing keeps working up to ${formatBytes(storage.limit * HARD_FACTOR)}; free up space or upgrade in Settings before then.`,
      usedBytes: storage.used,
      limitBytes: storage.limit,
    },
  ];
}
