import type { FileEntry } from './file-manifest';
import type { FileContentHead } from './file-content.repository';

/** Trusted host callback, never renderer/remote-supplied code. Allocate a fresh
 * managed folder, materialize these exact files and verify their bytes/modes
 * before returning. Do not enqueue API calls or start watchers here. Retain
 * prepared folders after database failure; they may already contain user edits. */
export type PrepareImportedWorkspace = (workspace: {
  id: string;
  slug: string | null;
  kind: string | null;
  role: 'main' | 'task' | 'review';
  head: FileContentHead | null;
  files: FileEntry[];
}) => Promise<string>;
