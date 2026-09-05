/**
 * Access modes for a Crux Store key. A key's mode is fixed by its first write
 * (or by the author in the Store pane) and every later write must agree.
 *
 * - `public`    — open: anyone reads and writes one shared value.
 * - `protected` — authenticated, per user: a signed-in account is required and
 *                 each account has its own private slot.
 * - `common`    — authenticated, shared: one value per key belonging to the
 *                 crux; a signed-in account is required to write, increment or
 *                 delete it, and anyone can read it.
 */
export const STORE_MODES = ['public', 'protected', 'common'] as const;
export type StoreMode = (typeof STORE_MODES)[number];

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
