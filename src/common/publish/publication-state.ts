/** Server-owned publication facts; client metadata must never select storage or cleanup targets. */
export const PUBLICATION_META_KEYS = [
  'publishedAt',
  'publishedVersion',
  'publishLayout',
  'publishedBytes',
  'publishStorageId',
  'retiredPublications',
  'publicationRemoving',
  'toolPackage',
];

export function withoutPublicationState(
  meta: Record<string, unknown> | undefined,
) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return {};
  return Object.fromEntries(
    Object.entries(meta).filter(
      ([key]) => !PUBLICATION_META_KEYS.includes(key),
    ),
  );
}
