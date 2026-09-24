import { captureCruxUpdate, LocalCruxUpdate } from './crux-update';

/** Local creation preserves desktop defaults; ownership is captured, never inferred from navigation. */
export interface LocalCruxCreate {
  id?: string;
  gardenId?: string;
  slug: string;
  authorId: string;
  homeId: string;
  title?: string;
  description?: string;
  data?: string;
  type?: string;
  kind?: LocalCruxUpdate['kind'];
  meta?: Record<string, unknown>;
}

/** Trusted host hook, not renderer-supplied code. It must not call the queued owner.
 * Prepared files survive a later DB failure: never remove possibly edited content. */
export type PrepareCruxFolder = (slug: string) => string | Promise<string>;

export function captureCruxCreate(input: LocalCruxCreate): LocalCruxCreate {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Use a Crux creation object');
  const { id, gardenId, authorId, homeId, ...details } = input;
  if (
    gardenId !== undefined &&
    (typeof gardenId !== 'string' || !gardenId.trim())
  )
    throw new Error('Use a destination Garden identity');
  for (const [key, value] of Object.entries({ id, authorId, homeId })) {
    if (key === 'id' && value === undefined) continue;
    if (typeof value !== 'string' || !value.trim())
      throw new Error(`Use a Crux ${key}`);
  }
  const allowed = new Set([
    'slug',
    'title',
    'description',
    'data',
    'type',
    'kind',
    'meta',
  ]);
  for (const key of Object.keys(details))
    if (!allowed.has(key))
      throw new Error(`Unsupported Crux creation field: ${key}`);
  const captured = captureCruxUpdate(details);
  if (!captured.slug?.trim()) throw new Error('Use a Crux slug');
  if (
    captured.meta?.projectFolder !== undefined &&
    (typeof captured.meta.projectFolder !== 'string' ||
      !captured.meta.projectFolder.trim())
  )
    throw new Error('Use a Project Folder path');
  return { ...captured, slug: captured.slug, id, gardenId, authorId, homeId };
}
