/** Stage independent immutable content with bounded disk work. Drain every
 * started operation before releasing the caller's transaction, even on failure. */
export async function stageContentInBatches<T>(
  items: readonly T[],
  stage: (item: T) => Promise<void>,
): Promise<void> {
  for (let offset = 0; offset < items.length; offset += 8) {
    const results = await Promise.allSettled(
      items.slice(offset, offset + 8).map(async (item) => stage(item)),
    );
    const failure = results.find((result) => result.status === 'rejected');
    if (failure) throw failure.reason;
  }
}
