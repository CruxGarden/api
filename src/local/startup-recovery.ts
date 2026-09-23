import { createHash, randomUUID } from 'crypto';
import { basename, dirname, join } from 'path';
import { linkSync, lstatSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { needsDesktopMigration } from './desktop-schema';
import { openDesktopRecovery } from './desktop-recovery';
const Database = require('better-sqlite3');

/**
 * Called under the runtime's file reservation, before opening writable storage.
 * Retain a standalone, committed pre-upgrade image. This is metadata recovery;
 * content must remain retained separately. Never overwrite an existing checkpoint.
 */
export function checkpointDesktopMigration(
  filename: string,
  allowInlineContent = false,
): string | null {
  const source = new Database(filename, {
    readonly: true,
    fileMustExist: true,
  });
  let image: Buffer;
  try {
    source.pragma('trusted_schema = OFF');
    source.exec('BEGIN');
    if (!needsDesktopMigration(source, allowInlineContent)) return null;
    // Capture WAL pages too. A raw filesystem copy could miss committed work.
    const detached = openDesktopRecovery(
      Uint8Array.from(source.serialize()).buffer,
      allowInlineContent,
    );
    try {
      image = Buffer.from(detached.serialize());
    } finally {
      detached.close();
    }
  } finally {
    source.close();
  }

  const fingerprint = createHash('sha256').update(image).digest('hex');
  const checkpoint = join(
    dirname(filename),
    `.${basename(filename)}.${fingerprint}.pre-migration`,
  );
  function verify(): void {
    // A symlink must not substitute an unrelated recovery file.
    if (
      !lstatSync(checkpoint).isFile() ||
      !readFileSync(checkpoint).equals(image)
    )
      throw new Error(`Recovery checkpoint is not intact: ${checkpoint}`);
  }
  try {
    verify();
    return checkpoint;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const staging = join(
    dirname(filename),
    `.${basename(filename)}.${randomUUID()}.checkpoint`,
  );
  try {
    writeFileSync(staging, image, { flag: 'wx', mode: 0o600, flush: true });
    // Publish complete bytes with exclusive creation. A failed/partial write
    // never claims the final checkpoint name; a retry verifies any existing one.
    try {
      linkSync(staging, checkpoint);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    verify();
    return checkpoint;
  } finally {
    try {
      rmSync(staging, { force: true });
    } catch {
      /* Retain an orphan staging file rather than mask the original error. */
    }
  }
}
