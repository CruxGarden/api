export function captureMetadata(value: unknown): Record<string, unknown> {
  const seen = new Set<object>();
  function check(item: unknown): void {
    if (item === null || typeof item === 'string' || typeof item === 'boolean')
      return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (
      !item ||
      typeof item !== 'object' ||
      (!Array.isArray(item) &&
        Object.getPrototypeOf(item) !== Object.prototype &&
        Object.getPrototypeOf(item) !== null)
    )
      throw new Error('Use finite JSON metadata');
    if (seen.has(item)) throw new Error('Use acyclic JSON metadata');
    seen.add(item);
    if (Array.isArray(item))
      for (let i = 0; i < item.length; i++) check(item[i]);
    else for (const entry of Object.values(item)) check(entry);
    seen.delete(item);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Use a metadata object');
  check(value);
  return JSON.parse(JSON.stringify(value));
}
