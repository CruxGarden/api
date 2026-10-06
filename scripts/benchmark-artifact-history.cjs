// Synthetic storage experiment, not a replacement schema or an end-to-end app
// benchmark. File content blobs are identical across candidates and excluded.
const Database = require('better-sqlite3');
const { randomUUID, createHash } = require('node:crypto');
const { deflateSync, inflateSync } = require('node:zlib');
const { mkdtempSync, readFileSync, statSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { performance } = require('node:perf_hooks');
const assert = require('node:assert/strict');

const count = Number(process.argv[2] || 10000);
const snapshots = Number(process.argv[3] || 50);
if (
  !Number.isInteger(count) ||
  count < 1 ||
  count > 100000 ||
  !Number.isInteger(snapshots) ||
  snapshots < 2 ||
  snapshots > 200
)
  throw new Error('Use 1–100000 files and 2–200 snapshots');
const scratch = mkdtempSync(join(tmpdir(), 'crux-history-cost-'));
const hash = (data) => createHash('sha256').update(data).digest('hex');
const now = '2026-09-22T00:00:00.000Z';
const author = randomUUID();
const home = randomUUID();
const current = randomUUID();
const entries = Array.from({ length: count }, (_, i) => {
  const path = `src/group-${Math.floor(i / 100)}/file-${i}.txt`;
  return {
    id: randomUUID(),
    type: 'artifact',
    kind: 'file',
    path,
    meta: { path, attribution: { authorId: author } },
    author_id: author,
    home_id: home,
    encoding: 'utf-8',
    mime_type: 'text/plain',
    filename: `file-${i}.txt`,
    size: 512,
    fingerprint: hash(`content-${i}`),
    created: now,
    updated: now,
  };
});
const columns = [
  'id',
  'type',
  'kind',
  'path',
  'meta',
  'resource_id',
  'resource_type',
  'author_id',
  'home_id',
  'encoding',
  'mime_type',
  'filename',
  'size',
  'fingerprint',
  'created',
  'updated',
];
function insertRows(db, rows, owner, clone = false) {
  for (let start = 0; start < rows.length; start += 400) {
    const chunk = rows.slice(start, start + 400);
    const params = chunk.flatMap((e) => [
      clone ? randomUUID() : e.id,
      e.type,
      e.kind,
      e.path,
      JSON.stringify(e.meta),
      owner,
      'crux',
      e.author_id,
      e.home_id,
      e.encoding,
      e.mime_type,
      e.filename,
      e.size,
      e.fingerprint,
      e.created,
      e.updated,
    ]);
    db.prepare(
      `INSERT INTO artifacts (${columns.join(',')}) VALUES ${chunk.map(() => '(' + columns.map(() => '?').join(',') + ')').join(',')}`,
    ).run(...params);
  }
}
function run(mode) {
  const filename = join(scratch, `${mode}.db`);
  const db = new Database(filename);
  db.pragma('journal_mode = WAL');
  db.exec(
    readFileSync(
      join(__dirname, '../test/fixtures/desktop-schema.sql'),
      'utf8',
    ),
  );
  db.exec(
    'CREATE TABLE history_roots (id TEXT PRIMARY KEY, fingerprint TEXT); CREATE TABLE manifest_objects (fingerprint TEXT PRIMARY KEY, bytes BLOB NOT NULL)',
  );
  const working = structuredClone(entries);
  db.transaction(() => insertRows(db, working, current))();
  const store = db.prepare(
    'INSERT OR IGNORE INTO manifest_objects VALUES (?, ?)',
  );
  const lookup = db.prepare(
    'SELECT bytes FROM manifest_objects WHERE fingerprint = ?',
  );
  const rootWrite = db.prepare('INSERT INTO history_roots VALUES (?, ?)');
  const roots = [];
  let submittedRows = 0;
  function put(value) {
    const bytes = Buffer.from(JSON.stringify(value));
    const fingerprint = hash(bytes);
    submittedRows += store.run(fingerprint, deflateSync(bytes)).changes;
    return fingerprint;
  }
  function get(fingerprint) {
    return JSON.parse(inflateSync(lookup.get(fingerprint).bytes).toString());
  }
  let leaves = [];
  const start = performance.now();
  for (let step = 0; step < snapshots; step++) {
    const changed = step % count;
    working[changed].fingerprint = hash(`edit-${step}`);
    working[changed].updated =
      `2026-09-22T00:${String(Math.floor(step / 60)).padStart(2, '0')}:${String(step % 60).padStart(2, '0')}.000Z`;
    db.prepare(
      'UPDATE artifacts SET fingerprint = ?, updated = ? WHERE id = ?',
    ).run(
      working[changed].fingerprint,
      working[changed].updated,
      working[changed].id,
    );
    const id = randomUUID();
    if (mode === 'row-clones') {
      // Use the same 400-row metadata clone shape as the current service,
      // without renderer IPC overhead. This favors the existing baseline.
      db.transaction(() => insertRows(db, working, id, true))();
      submittedRows += count;
      rootWrite.run(id, null);
      roots.push(id);
    } else {
      db.transaction(() => {
        let fingerprint;
        if (mode === 'flat-manifest') fingerprint = put(working);
        else {
          // Fixed pages only illustrate structural sharing for one-file edits.
          // This is NOT a decided tree format: insertion/rename/rebalance and
          // metadata/Artifact-ID compatibility still require a design.
          if (step === 0)
            leaves = Array.from({ length: Math.ceil(count / 256) }, (_, page) =>
              put(working.slice(page * 256, (page + 1) * 256)),
            );
          else {
            const page = Math.floor(changed / 256);
            leaves[page] = put(working.slice(page * 256, (page + 1) * 256));
          }
          fingerprint = put(leaves);
        }
        rootWrite.run(id, fingerprint);
        roots.push(fingerprint);
      })();
    }
  }
  const captureMs = performance.now() - start;
  const readStart = performance.now();
  const restored =
    mode === 'row-clones'
      ? db
          .prepare(
            'SELECT * FROM artifacts WHERE resource_id = ? ORDER BY path',
          )
          .all(roots.at(-1))
          .map((r) => ({ ...r, meta: JSON.parse(r.meta) }))
      : mode === 'flat-manifest'
        ? get(roots.at(-1))
        : get(roots.at(-1)).flatMap(get);
  const lookupMs = performance.now() - readStart;
  const expected = new Map(working.map((e) => [e.path, e]));
  assert.equal(restored.length, count);
  for (const entry of restored) {
    const original = expected.get(entry.path);
    for (const field of [
      'fingerprint',
      'encoding',
      'mime_type',
      'size',
      'filename',
      'created',
      'updated',
      'meta',
    ])
      assert.deepEqual(entry[field], original[field]);
  }
  // Prove the first history state remains unchanged after later edits.
  const first =
    mode === 'row-clones'
      ? db
          .prepare(
            'SELECT path, fingerprint FROM artifacts WHERE resource_id = ?',
          )
          .all(roots[0])
      : mode === 'flat-manifest'
        ? get(roots[0])
        : get(roots[0]).flatMap(get);
  const initial = new Map(first.map((e) => [e.path, e.fingerprint]));
  assert.equal(initial.get(entries[0].path), hash('edit-0'));
  if (count > 1)
    assert.equal(initial.get(entries[1].path), entries[1].fingerprint);
  const artifactRows = db
    .prepare('SELECT COUNT(*) AS n FROM artifacts')
    .get().n;
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
  return {
    mode,
    files: count,
    snapshots,
    captureMs: Math.round(captureMs),
    latestManifestReadMs: Math.round(lookupMs),
    databaseBytes: statSync(filename).size,
    artifactRows,
    addedHistoryObjects: submittedRows,
    verified: 'first and last path/content/metadata preserved',
  };
}
try {
  console.log(
    JSON.stringify(
      {
        scope:
          'Synthetic metadata-only comparison; current file index included; no file content bytes, IPC, UI, sync or migration. Fixed pages do not prove rename/insert/delete behavior.',
        results: ['row-clones', 'flat-manifest', 'shared-pages'].map(run),
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
