import { toolSummaryOf } from './tool-summary';

/**
 * What of a crux's `meta` the public may see.
 *
 * `meta` is the crux's working state as the app keeps it — the model choice,
 * the system prompt, background-turn queues, the local Project Folder path —
 * and sync-on-publish uploads all of it. The public reads (Explore, an
 * author's garden, a crux page) must hand out only what the public page needs:
 * the summary and, when the creator chose to share it, the conversation ("How
 * was this made?", ADR 0084), the snapshots that render that conversation, a
 * published Mood's swatch, tags, the publish facts and a published Tool's
 * sanitized trust summary. Everything else stays private to the owner.
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
  'publishedBytes',
  'toolPackage',
  'conversationPublished',
  'toolSummary',
] as const;

/** The public fields of a published Tool's package reference. */
const TOOL_PACKAGE_KEYS = [
  'version',
  'artifactId',
  'fingerprint',
  'size',
  'fileCount',
  'unpackedBytes',
] as const;

/** Keys that exist only to render the published conversation. */
const CONVERSATION_KEYS = ['messages', 'personaSnapshots'] as const;

/**
 * ADR 0084: the conversation is published only when the creator chose to
 * publish it. Absent means the pre-0084 behaviour (published); `false` removes
 * the conversation and the Persona snapshots that render it; a message marked
 * `excludedFromPublish` never leaves the creator's computer through the host,
 * even if an older or modified client sends it. Applied before storage and
 * again on every public read. Returns a new object; the input is not changed.
 */
export function withConversationPolicy(
  meta: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...meta };
  if (out.conversationPublished === false) {
    for (const key of CONVERSATION_KEYS) delete out[key];
    return out;
  }
  if (Array.isArray(out.messages))
    out.messages = out.messages.filter(
      (message) =>
        !(
          message &&
          typeof message === 'object' &&
          (message as { excludedFromPublish?: unknown }).excludedFromPublish ===
            true
        ),
    );
  return out;
}

export function publicCruxMeta(
  meta: Record<string, unknown> | null | undefined,
  context: { publisher?: unknown } = {},
): Record<string, unknown> | null | undefined {
  if (!meta || typeof meta !== 'object') return meta;
  const policed = withConversationPolicy(meta);
  const out: Record<string, unknown> = {};
  for (const key of PUBLIC_META_KEYS) {
    if (key in policed && policed[key] !== undefined) out[key] = policed[key];
  }
  // Always a boolean on the public side, so the page can say the creator
  // kept the conversation private rather than guessing from an empty list.
  out.conversationPublished = meta.conversationPublished !== false;
  // Never echo a stored summary or a client manifest as-is: rebuild it from
  // the allow-listed fields only.
  // The package reference is server-owned; still pass only its known fields
  // (the stored trust summary is re-derived below, never echoed).
  if (out.toolPackage && typeof out.toolPackage === 'object') {
    const pkg = out.toolPackage as Record<string, unknown>;
    out.toolPackage = Object.fromEntries(
      TOOL_PACKAGE_KEYS.filter((key) => pkg[key] !== undefined).map((key) => [
        key,
        pkg[key],
      ]),
    );
  }
  const toolSummary = toolSummaryOf(meta, context.publisher);
  if (toolSummary) out.toolSummary = toolSummary;
  else delete out.toolSummary;
  return out;
}

/** The same row with its `meta` reduced to the public subset. */
export function withPublicMeta<
  T extends { meta?: Record<string, unknown> | null },
>(row: T): T {
  const record = row as unknown as Record<string, unknown>;
  // Explore rows carry the author's current username (raw snake_case);
  // an entity may carry it camelCased. Fresher than the publish-time record.
  const publisher = record.author_username ?? record.authorUsername;
  return {
    ...row,
    meta: publicCruxMeta(row.meta, { publisher }) as T['meta'],
  };
}
