import { randomUUID } from 'crypto';

/**
 * Named desktop commands for the writes the app used to send as SQL: authors,
 * dimensions, the Crux Store, a Garden wipe and the post-import sanitation.
 * Each runs in one SQLite transaction on the owner's connection, with the same
 * semantics the app's own statements had (hard deletes where they deleted,
 * shallow metadata merges where they merged). Inputs are captured by callers.
 */

/** A better-sqlite3 connection, as the runtime hands it over. */
export interface Connection {
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  transaction<T>(fn: () => T): () => T;
}

const now = () => new Date().toISOString();
const text = (v: unknown, what: string) => {
  if (typeof v !== 'string' || !v) throw new Error(`Use ${what}`);
  return v;
};
const optionalText = (v: unknown, what: string) => {
  if (v !== undefined && v !== null && typeof v !== 'string')
    throw new Error(`Use ${what}`);
  return (v as string | null | undefined) ?? null;
};
const object = (v: unknown, what: string): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v))
    throw new Error(`Use ${what}`);
  return v as Record<string, unknown>;
};
const parse = (raw: unknown): Record<string, unknown> => {
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
};

// ── Authors ─────────────────────────────────────────────────────────────────

export interface AuthorCreate {
  username: string;
  displayName?: string | null;
  accountId?: string | null;
  homeId?: string | null;
  /** Record it as this installation's local author, in the same transaction. */
  local?: boolean;
}
export interface AuthorRow {
  id: string;
  username: string;
  display_name: string | null;
  bio: string | null;
  account_id: string | null;
  home_id: string | null;
  meta: string;
  created: string;
  updated: string;
}

export function createAuthor(c: Connection, input: AuthorCreate): AuthorRow {
  const username = text(input.username, 'a username');
  const displayName = optionalText(input.displayName, 'a display name');
  const id = randomUUID();
  const at = now();
  const row: AuthorRow = {
    id,
    username,
    display_name: displayName,
    bio: null,
    account_id: optionalText(input.accountId, 'an account') ?? `local-${id}`,
    home_id: optionalText(input.homeId, 'a home') ?? `home-${id}`,
    meta: '{}',
    created: at,
    updated: at,
  };
  c.transaction(() => {
    c.prepare(
      `INSERT INTO authors (id, username, display_name, bio, account_id, home_id, meta, created, updated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id,
      row.username,
      row.display_name,
      row.bio,
      row.account_id,
      row.home_id,
      row.meta,
      row.created,
      row.updated,
    );
    if (input.local)
      c.prepare(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('cruxgarden:localAuthorId', ?)",
      ).run(row.id);
  })();
  return row;
}

export interface AuthorUpdate {
  username?: string;
  displayName?: string | null;
  bio?: string | null;
  meta?: Record<string, unknown>;
}

export function updateAuthor(
  c: Connection,
  id: string,
  patch: AuthorUpdate,
): void {
  text(id, 'an author');
  const changes = object(patch, 'an author update');
  c.transaction(() => {
    const existing = c
      .prepare('SELECT meta FROM authors WHERE id = ?')
      .get(id) as { meta: string } | undefined;
    if (!existing) throw new Error('Author not found');
    const sets: string[] = ['updated = ?'];
    const params: unknown[] = [now()];
    if (changes.username !== undefined) {
      sets.push('username = ?');
      params.push(text(changes.username, 'a username'));
    }
    if (changes.displayName !== undefined) {
      sets.push('display_name = ?');
      params.push(optionalText(changes.displayName, 'a display name'));
    }
    if (changes.bio !== undefined) {
      sets.push('bio = ?');
      params.push(optionalText(changes.bio, 'a bio'));
    }
    if (changes.meta !== undefined) {
      sets.push('meta = ?');
      params.push(
        JSON.stringify({
          ...parse(existing.meta),
          ...object(changes.meta, 'author metadata'),
        }),
      );
    }
    c.prepare(`UPDATE authors SET ${sets.join(', ')} WHERE id = ?`).run(
      ...params,
      id,
    );
  })();
}

/**
 * The local author becomes the connected account's author: every row that
 * named the old id names the new one, and the installation records it — all
 * or nothing.
 */
export function rekeyLocalAuthor(
  c: Connection,
  input: { oldId: string; newId: string; accountId: string },
): void {
  const oldId = text(input.oldId, 'the current author');
  const newId = text(input.newId, 'the new author');
  const accountId = text(input.accountId, 'an account');
  if (oldId === newId) return;
  c.transaction(() => {
    for (const table of ['cruxes', 'artifacts', 'dimensions'])
      c.prepare(`UPDATE ${table} SET author_id = ? WHERE author_id = ?`).run(
        newId,
        oldId,
      );
    c.prepare(
      'UPDATE authors SET id = ?, account_id = ?, updated = ? WHERE id = ?',
    ).run(newId, accountId, now(), oldId);
    c.prepare(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('cruxgarden:localAuthorId', ?)",
    ).run(newId);
  })();
}

// ── Dimensions ──────────────────────────────────────────────────────────────

export interface DimensionCreate {
  sourceId: string;
  targetId: string;
  type: string;
  kind?: string | null;
  weight?: number | null;
  homeId: string;
  note?: string | null;
  meta?: Record<string, unknown>;
}

export function createDimension(
  c: Connection,
  input: DimensionCreate,
): { id: string; created: string } {
  const id = randomUUID();
  const at = now();
  if (!['gate', 'garden', 'growth', 'graft'].includes(input.type))
    throw new Error('Use a Dimension type');
  if (
    input.weight !== undefined &&
    input.weight !== null &&
    !Number.isFinite(input.weight)
  )
    throw new Error('Use a number for the weight');
  c.prepare(
    `INSERT INTO dimensions (id, source_id, target_id, type, kind, weight, home_id, note, meta, created, updated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    text(input.sourceId, 'a source'),
    text(input.targetId, 'a target'),
    input.type,
    optionalText(input.kind, 'a kind'),
    input.weight ?? null,
    text(input.homeId, 'a home'),
    optionalText(input.note, 'a note'),
    JSON.stringify(input.meta ? object(input.meta, 'Dimension metadata') : {}),
    at,
    at,
  );
  return { id, created: at };
}

export function updateDimension(
  c: Connection,
  id: string,
  patch: {
    kind?: string | null;
    weight?: number | null;
    note?: string | null;
    meta?: Record<string, unknown>;
  },
): void {
  text(id, 'a Dimension');
  const changes = object(patch, 'a Dimension update');
  c.transaction(() => {
    const existing = c
      .prepare('SELECT meta FROM dimensions WHERE id = ?')
      .get(id) as { meta: string } | undefined;
    if (!existing) throw new Error('Dimension not found');
    const sets = ['updated = ?'];
    const params: unknown[] = [now()];
    if (changes.kind !== undefined) {
      sets.push('kind = ?');
      params.push(optionalText(changes.kind, 'a kind'));
    }
    if (changes.weight !== undefined) {
      sets.push('weight = ?');
      params.push(changes.weight ?? null);
    }
    if (changes.note !== undefined) {
      sets.push('note = ?');
      params.push(optionalText(changes.note, 'a note'));
    }
    if (changes.meta !== undefined) {
      sets.push('meta = ?');
      params.push(
        JSON.stringify({
          ...parse(existing.meta),
          ...object(changes.meta, 'Dimension metadata'),
        }),
      );
    }
    c.prepare(`UPDATE dimensions SET ${sets.join(', ')} WHERE id = ?`).run(
      ...params,
      id,
    );
  })();
}

export function deleteDimension(c: Connection, id: string): void {
  c.prepare('DELETE FROM dimensions WHERE id = ?').run(text(id, 'a Dimension'));
}

// ── The Crux Store ──────────────────────────────────────────────────────────

export interface StoreEntry {
  cruxId: string;
  key: string;
  /** Absent for the Crux's public entry; a visitor's own entry otherwise. */
  visitorId?: string | null;
  /** Serialized value, as the Store keeps it. */
  value: string;
  mode: string;
}

/** Write one Store entry, replacing the value of an existing one. */
export function storeSet(c: Connection, entry: StoreEntry): void {
  const cruxId = text(entry.cruxId, 'a Crux');
  const key = text(entry.key, 'a key');
  const visitorId = optionalText(entry.visitorId, 'a visitor');
  if (typeof entry.value !== 'string') throw new Error('Use a stored value');
  const mode = text(entry.mode, 'a mode');
  const at = now();
  c.transaction(() => {
    const existing = (
      visitorId
        ? c
            .prepare(
              'SELECT id FROM store WHERE crux_id = ? AND key = ? AND visitor_id = ?',
            )
            .get(cruxId, key, visitorId)
        : c
            .prepare(
              'SELECT id FROM store WHERE crux_id = ? AND key = ? AND visitor_id IS NULL',
            )
            .get(cruxId, key)
    ) as { id: string } | undefined;
    if (existing)
      c.prepare(
        'UPDATE store SET value = ?, mode = ?, updated = ? WHERE id = ?',
      ).run(entry.value, mode, at, existing.id);
    else
      c.prepare(
        `INSERT INTO store (id, crux_id, visitor_id, key, value, mode, created, updated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(randomUUID(), cruxId, visitorId, key, entry.value, mode, at, at);
  })();
}

export function storeDelete(
  c: Connection,
  input: { cruxId: string; key: string; visitorId?: string | null },
): void {
  const cruxId = text(input.cruxId, 'a Crux');
  const key = text(input.key, 'a key');
  const visitorId = optionalText(input.visitorId, 'a visitor');
  if (visitorId)
    c.prepare(
      'DELETE FROM store WHERE crux_id = ? AND key = ? AND visitor_id = ?',
    ).run(cruxId, key, visitorId);
  else
    c.prepare(
      'DELETE FROM store WHERE crux_id = ? AND key = ? AND visitor_id IS NULL',
    ).run(cruxId, key);
}

export function storeClear(c: Connection, cruxId: string): void {
  c.prepare('DELETE FROM store WHERE crux_id = ?').run(text(cruxId, 'a Crux'));
}

// ── Whole Garden ────────────────────────────────────────────────────────────

const WIPED = [
  'task_merges',
  'working_copies',
  'store',
  'cruxes',
  'artifacts',
  'dimensions',
  'authors',
  'settings',
];

/** Empty the installation's Garden in one transaction (the host wipes blobs). */
export function wipeGarden(c: Connection): void {
  c.transaction(() => {
    const tables = new Set(
      (
        c
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all() as { name: string }[]
      ).map((t) => t.name),
    );
    if (tables.has('file_content_heads'))
      c.prepare('DELETE FROM file_content_heads').run();
    if (tables.has('edit_history')) c.prepare('DELETE FROM edit_history').run();
    for (const table of WIPED)
      if (tables.has(table)) c.prepare(`DELETE FROM ${table}`).run();
  })();
}

/**
 * After a whole-Garden image is admitted: runtime handles from the machine it
 * came from are dropped, Task folders are this machine's to make, and reviews
 * that were open become cancelled — all at once.
 */
/** A Working Copy's metadata without this machine's folder, publication or runtime handles. */
function portableCopyMeta(
  meta: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...meta };
  for (const key of [
    'projectFolder',
    'publishedAt',
    'publishedVersion',
    'publishedFingerprints',
    'turnJob',
    'turnQueue',
    'agentHost',
  ])
    delete out[key];
  if (out.settings && typeof out.settings === 'object') {
    const settings = { ...(out.settings as Record<string, unknown>) };
    delete settings.agentSessionId;
    delete settings.agentSessions;
    delete settings.agentHost;
    out.settings = settings;
  }
  return out;
}

export function sanitizeImportedGarden(c: Connection): void {
  c.transaction(() => {
    c.prepare(
      `UPDATE cruxes SET meta = json_remove(meta,
        '$.settings.agentSessionId', '$.settings.agentSessions', '$.settings.agentHost',
        '$.agentHost', '$.turnJob', '$.turnQueue')
       WHERE meta IS NOT NULL AND json_valid(meta)`,
    ).run();
    const copies = c.prepare('SELECT id, meta FROM working_copies').all() as {
      id: string;
      meta: string;
    }[];
    for (const copy of copies)
      c.prepare(
        'UPDATE working_copies SET project_folder = NULL, meta = ? WHERE id = ?',
      ).run(JSON.stringify(portableCopyMeta(parse(copy.meta))), copy.id);
    c.prepare(
      `UPDATE task_merges SET phase = 'cancelled',
        data = CASE WHEN json_valid(data) AND json_type(data) = 'object'
          THEN json_remove(json_set(data, '$.phase', 'cancelled'), '$.previewUrl')
          ELSE data END
       WHERE phase = 'review' OR (phase = 'cancelled' AND json_extract(data, '$.phase') = 'review')`,
    ).run();
  })();
}

/** Point a Working Copy at the folder made for it on this machine. */
export function setWorkingCopyFolder(
  c: Connection,
  id: string,
  folder: string,
): void {
  const result = c
    .prepare('UPDATE working_copies SET project_folder = ? WHERE id = ?')
    .run(text(folder, 'a folder'), text(id, 'a Working Copy'));
  if (result.changes !== 1) throw new Error('Working Copy not found');
}
