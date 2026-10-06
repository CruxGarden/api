import { randomUUID } from 'node:crypto';
import { ServiceUnavailableException } from '@nestjs/common';
import { z } from 'zod';
import {
  StoreService,
  isStoreObjectMissing,
} from '../common/services/store.service';
import type { SyncHead } from './sync.repository';

const timestamp = z
  .string()
  .refine((value) => Number.isFinite(Date.parse(value)));
const size = z
  .number()
  .int()
  .nonnegative()
  .max(500 * 1024 * 1024);
const garden = z.object({ syncedAt: timestamp, size });
const cruxes = z
  .array(
    z.object({
      cruxId: z.string().uuid(),
      slug: z.string(),
      title: z.string(),
      updatedAt: timestamp,
      size,
    }),
  )
  .max(10000);

/** Absence is explicit; permission errors, outages and malformed bytes are refusals. */
async function readMetadata(
  store: StoreService,
  namespace: string,
  path: string,
): Promise<unknown | undefined> {
  try {
    return JSON.parse(
      (
        await store.download({
          namespace,
          path,
          maxBytes: 4 * 1024 * 1024,
          timeoutMs: 5000,
        })
      ).data.toString(),
    );
  } catch (error) {
    if (isStoreObjectMissing(error)) return undefined;
    throw new ServiceUnavailableException(
      'Backup metadata is unavailable or invalid; existing backups were preserved',
    );
  }
}

/** Admit the current supported catalog once. Objects are referenced in place, never rewritten. */
export async function readBackupCatalog(
  store: StoreService,
  namespace: string,
  accountId: string,
): Promise<SyncHead[]> {
  const prefix = `sync/${accountId}`;
  const rawCruxes = await readMetadata(
    store,
    namespace,
    `${prefix}/cruxes/_index.json`,
  );
  const rawGarden = await readMetadata(
    store,
    namespace,
    `${prefix}/garden-meta.json`,
  );
  const parsedCruxes = cruxes.safeParse(
    rawCruxes === undefined ? [] : rawCruxes,
  );
  const parsedGarden =
    rawGarden === undefined ? null : garden.safeParse(rawGarden);
  if (!parsedCruxes.success || (parsedGarden && !parsedGarden.success))
    throw new ServiceUnavailableException(
      'Backup metadata is invalid; existing backups were preserved',
    );
  const entries = parsedCruxes.data;
  if (new Set(entries.map((entry) => entry.cruxId)).size !== entries.length)
    throw new ServiceUnavailableException(
      'Backup metadata has duplicate Crux IDs',
    );
  const heads: SyncHead[] = entries.map((entry) => ({
    account_id: accountId,
    kind: 'crux',
    object_id: entry.cruxId,
    revision_id: randomUUID(),
    status: 'active',
    storage_path: `${prefix}/cruxes/${entry.cruxId}.crux`,
    size: entry.size,
    slug: entry.slug,
    title: entry.title,
    updated_at: entry.updatedAt,
  }));
  if (parsedGarden?.success)
    heads.push({
      account_id: accountId,
      kind: 'garden',
      object_id: 'garden',
      revision_id: randomUUID(),
      status: 'active',
      storage_path: `${prefix}/garden.zip`,
      size: parsedGarden.data.size,
      slug: null,
      title: 'Garden backup',
      updated_at: parsedGarden.data.syncedAt,
    });
  return heads;
}
