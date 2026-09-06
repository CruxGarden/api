/**
 * What of a crux's `meta` the public may see.
 *
 * `meta` is the crux's working state as the app keeps it — the model choice,
 * the system prompt, background-turn queues, the local Project Folder path —
 * and sync-on-publish uploads all of it. The public reads (Explore, an
 * author's garden, a crux page) must hand out only what the public page needs:
 * the summary and the conversation ("How was this made?" is a feature), the
 * snapshots that render that conversation, a published Mood's swatch, tags,
 * and the publish facts. Everything else stays private to the owner.
 */
export const PUBLIC_META_KEYS = [
  'summary',
  'messages',
  'authorSnapshots',
  'personaSnapshots',
  'mood',
  'tags',
  'template',
  'game',
  'growthCount',
  'publishedAt',
  'publishedVersion',
  'publishLayout',
] as const;

export function publicCruxMeta(
  meta: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null | undefined {
  if (!meta || typeof meta !== 'object') return meta;
  const out: Record<string, unknown> = {};
  for (const key of PUBLIC_META_KEYS) {
    if (key in meta && meta[key] !== undefined) out[key] = meta[key];
  }
  return out;
}

/** The same row with its `meta` reduced to the public subset. */
export function withPublicMeta<
  T extends { meta?: Record<string, unknown> | null },
>(row: T): T {
  return { ...row, meta: publicCruxMeta(row.meta) as T['meta'] };
}
