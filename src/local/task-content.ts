import { FileEntry } from './file-manifest';

/** Task review deliberately excludes private/runtime housekeeping files. */
export function isTaskContent(path: string): boolean {
  return (
    !/(^|\/)(\.env(?:\.[^/]*)?|\.crux|\.git|\.claude|\.codex|\.cursor|node_modules|dist|\.astro)(\/|$)/i.test(
      path,
    ) &&
    !/\.(pem|key)$/i.test(path) &&
    !['AGENTS.md', 'CLAUDE.md', 'preview.jpg'].includes(path) &&
    !path.includes('.crux-write-')
  );
}

export function assertTaskContent(
  entries: FileEntry[],
  manifest: Record<string, any>,
) {
  const files = entries.filter((entry) => isTaskContent(entry.path));
  if (
    files.length !== Object.keys(manifest).length ||
    files.some((file) => {
      const expected = manifest[file.path];
      return (
        !expected ||
        file.fingerprint !== expected.fingerprint ||
        file.mode !== expected.mode ||
        file.encoding !== expected.encoding ||
        file.mimeType !== expected.mimeType ||
        (expected.size !== undefined && file.size !== expected.size)
      );
    })
  )
    throw new Error(
      'Task files changed after review. Prepare and check the review again.',
    );
}
