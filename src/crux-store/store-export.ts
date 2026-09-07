import { BadRequestException } from '@nestjs/common';
import Store from './entities/crux-store.entity';

/**
 * The Crux Store as a file. One document, the whole store, JSON — the shape
 * Firebase users know from their exports: values keyed by key, per-visitor
 * values keyed by visitor then key. The same file is read back by import,
 * on the live store or the workspace's local one, so data moves freely
 * between the two and survives an unshare.
 *
 *   { "format": "crux-store", "version": 1, "cruxId": "…", "exportedAt": "…",
 *     "public":    { "leaderboard:2026-09-06": {…} },
 *     "protected": { "<visitorId>": { "played:2026-09-06": {…} } } }
 */
export const STORE_EXPORT_FORMAT = 'crux-store';
export const STORE_EXPORT_VERSION = 1;

export interface StoreExport {
  format: typeof STORE_EXPORT_FORMAT;
  version: typeof STORE_EXPORT_VERSION;
  cruxId: string;
  exportedAt: string;
  public: Record<string, unknown>;
  protected: Record<string, Record<string, unknown>>;
}

export interface StoreImportEntry {
  key: string;
  value: unknown;
  mode: 'public' | 'protected';
  visitorId: string | null;
}

export function toStoreExport(
  cruxId: string,
  rows: Pick<Store, 'key' | 'value' | 'mode' | 'visitorId'>[],
  now = new Date(),
): StoreExport {
  const out: StoreExport = {
    format: STORE_EXPORT_FORMAT,
    version: STORE_EXPORT_VERSION,
    cruxId,
    exportedAt: now.toISOString(),
    public: {},
    protected: {},
  };
  for (const r of rows) {
    if (r.visitorId) {
      (out.protected[r.visitorId] ??= {})[r.key] = r.value;
    } else {
      out.public[r.key] = r.value;
    }
  }
  return out;
}

const MAX_KEY = 256;
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Validate a document someone uploaded and flatten it to writes. Strict about
 * shape (so a wrong file fails loudly, not half-way), lenient about origin:
 * `cruxId` is informational — a store exported from one crux may be imported
 * into another.
 */
export function fromStoreExport(input: unknown): StoreImportEntry[] {
  if (!isRecord(input)) throw new BadRequestException('Expected a JSON object');
  if (input.format !== STORE_EXPORT_FORMAT)
    throw new BadRequestException(
      `Not a Crux Store export (format "${STORE_EXPORT_FORMAT}" expected)`,
    );
  if (input.version !== STORE_EXPORT_VERSION)
    throw new BadRequestException(
      `Unsupported export version ${String(input.version)}`,
    );
  const pub = input.public ?? {};
  const prot = input.protected ?? {};
  if (!isRecord(pub) || !isRecord(prot))
    throw new BadRequestException('"public" and "protected" must be objects');
  const entries: StoreImportEntry[] = [];
  const checkKey = (key: string) => {
    if (!key || key.length > MAX_KEY)
      throw new BadRequestException(`Invalid key "${key.slice(0, 40)}"`);
  };
  for (const [key, value] of Object.entries(pub)) {
    checkKey(key);
    entries.push({ key, value, mode: 'public', visitorId: null });
  }
  for (const [visitorId, values] of Object.entries(prot)) {
    if (!visitorId || !isRecord(values))
      throw new BadRequestException(
        `"protected" must map visitor ids to objects (at "${visitorId}")`,
      );
    for (const [key, value] of Object.entries(values)) {
      checkKey(key);
      entries.push({ key, value, mode: 'protected', visitorId });
    }
  }
  return entries;
}
