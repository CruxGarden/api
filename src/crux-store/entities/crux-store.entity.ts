/**
 * Access modes for a Crux Store key. A key's mode is fixed by its first write
 * (or by the author in the Store pane) and every later write must agree.
 *
 * Every write — set, increment, delete — needs a signed-in account, whatever
 * the mode: abuse is then one username, and it can be stopped. Reads are
 * where the modes differ.
 *
 * - `public`    — open: one value per key belonging to the crux; anyone reads
 *                 it, a connected account writes it.
 * - `protected` — per user: one private slot per account, read and written
 *                 only by its owner.
 */
export const STORE_MODES = ['public', 'protected'] as const;
export type StoreMode = (typeof STORE_MODES)[number];

/**
 * `common` was the "anyone reads, a connected account writes" bucket of
 * 2026-09-05. Since every write now needs an account it is exactly `public`;
 * pages written that week still send it, so it is accepted as an alias and
 * never stored (migration 20260905160000 rewrote the rows).
 */
export const DEPRECATED_STORE_MODE_ALIASES: Readonly<
  Record<string, StoreMode>
> = Object.freeze({ common: 'public' });

/** The modes a request may name: the real ones plus the deprecated alias. */
export const ACCEPTED_STORE_MODES = [
  ...STORE_MODES,
  ...Object.keys(DEPRECATED_STORE_MODE_ALIASES),
] as const;

/** `common` → `public`; anything else passes through untouched. */
export function normalizeStoreMode<T>(mode: T): T | StoreMode {
  return typeof mode === 'string' && mode in DEPRECATED_STORE_MODE_ALIASES
    ? DEPRECATED_STORE_MODE_ALIASES[mode]
    : mode;
}

/** Modes whose value lives in the single shared row (`visitor_id IS NULL`). */
export type SharedStoreMode = Exclude<StoreMode, 'protected'>;

export default class Store {
  id: string;
  cruxId: string;
  authorId: string;
  visitorId: string | null;
  key: string;
  value: any;
  mode: StoreMode;
  createdAt: Date;
  updatedAt: Date;

  constructor(partial: Partial<Store>) {
    Object.assign(this, partial);
  }
}
