// Isolated format-1 kernel measurement, not app/IPC/ingestion/GC acceptance.
// Run after npm run build: node scripts/benchmark-file-manifest.cjs 10000 50
const { FileManifest } = require('../dist/src/local/file-manifest');
const { createHash } = require('node:crypto');
const {
  mkdtempSync,
  readFileSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  rmSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const count = Number(process.argv[2] || 10000);
const versions = Number(process.argv[3] || 50);
if (
  !Number.isInteger(count) ||
  count < 100 ||
  count > 100000 ||
  !Number.isInteger(versions) ||
  versions < 2 ||
  versions > 200
)
  throw Error('Use 100–100000 files and 2–200 versions');
const scratch = mkdtempSync(join(tmpdir(), 'crux-file-manifest-'));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
let writes = 0,
  storedBytes = 0,
  reads = 0,
  readBytes = 0;
const store = {
  async read(id) {
    reads++;
    try {
      const bytes = readFileSync(join(scratch, id));
      readBytes += bytes.length;
      return bytes;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  },
  async write(id, bytes) {
    const fd = openSync(join(scratch, id), 'wx');
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    writes++;
    storedBytes += bytes.length;
  },
};
const tree = new FileManifest(store);
async function run() {
  // One repeated payload makes manifest overhead measurable independently of bytes.
  const payload = Buffer.from('Synthetic file bytes preserved exactly.');
  const fingerprint = hash(payload);
  await store.write(fingerprint, payload);
  const files = Array.from({ length: count }, (_, i) => ({
    id: `logical-file-${i}`,
    path: `src/group-${Math.floor(i / 100)}/file-${i}.txt`,
    fingerprint,
    size: payload.length,
    mimeType: 'text/plain',
    encoding: 'utf-8',
    mode: 0o644,
    attributes: {
      authorId: 'synthetic-author',
      homeId: 'synthetic-home',
      created: '2026-09-23T00:00:00.000Z',
      meta: { attribution: { author: 'synthetic-author' } },
    },
  }));
  writes = storedBytes = reads = readBytes = 0;
  const started = performance.now();
  let root = await tree.apply(
    null,
    files.map((put) => ({ put })),
  );
  const initialMs = performance.now() - started;
  const initialObjects = writes;
  const initialBytes = storedBytes;
  const first = root;
  const oldFirst = structuredClone(files[0]);
  const steps = [];
  const roots = [root];
  for (let version = 1; version < versions; version++) {
    const beforeWrites = writes,
      beforeBytes = storedBytes,
      beforeReads = reads;
    const changes = [];
    for (let offset = 0; offset < 10; offset++) {
      const i = (version * 97 + offset * 17) % count;
      files[i] = {
        ...files[i],
        mode: version % 2 ? 0o755 : 0o644,
        attributes: { ...files[i].attributes, revision: version },
      };
      changes.push({ put: files[i] });
    }
    // Exercise structural insert/delete/rename without changing logical identity.
    const renameIndex = (version * 101 + 51) % count;
    if (!changes.some((change) => change.put.id === files[renameIndex].id)) {
      changes.push({ remove: files[renameIndex].path });
      files[renameIndex] = {
        ...files[renameIndex],
        path: `renamed/version-${version}/file-${renameIndex}.txt`,
      };
      changes.push({ put: files[renameIndex] });
    }
    const start = performance.now();
    root = await tree.apply(root, changes);
    steps.push({
      ms: performance.now() - start,
      objects: writes - beforeWrites,
      bytes: storedBytes - beforeBytes,
      reads: reads - beforeReads,
    });
    roots.push(root);
  }
  const beforeLookupReads = reads;
  const lookupAt = performance.now();
  assert.deepEqual(await tree.get(root, files[0].path), files[0]);
  const lookupMs = performance.now() - lookupAt;
  const lookupReads = reads - beforeLookupReads;
  const projectedAt = performance.now();
  const latest = await tree.entries(root);
  const projectionMs = performance.now() - projectedAt;
  assert.deepEqual(
    latest,
    [...files].sort((a, b) => (a.path < b.path ? -1 : 1)),
  );
  assert.deepEqual(await tree.get(first, oldFirst.path), oldFirst);
  await tree.verify(first);
  await tree.verify(root);
  assert.equal(
    root,
    await tree.apply(
      null,
      files
        .slice()
        .reverse()
        .map((put) => ({ put })),
    ),
  );
  console.log(
    JSON.stringify(
      {
        files: count,
        versions,
        retainedRoots: roots.length,
        initialMs,
        initialObjects,
        initialBytes,
        storedManifestBytes: storedBytes,
        manifestObjects: writes,
        changeTotalMs: steps.reduce((n, s) => n + s.ms, 0),
        maxChangeObjects: Math.max(...steps.map((s) => s.objects)),
        maxChangeReads: Math.max(...steps.map((s) => s.reads)),
        latestProjectionMs: projectionMs,
        lookupMs,
        lookupReads,
        measuredStoreReads: reads,
        measuredReadBytes: readBytes,
        verified: [
          'first file unchanged',
          'latest exact metadata',
          'first/latest complete blob walk',
          'canonical rebuild',
        ],
        limits:
          'Synthetic single-process manifest kernel; repeated payload; includes file fsync but excludes directory fsync, API/database commits, IPC, current index, migration and app journeys.',
      },
      null,
      2,
    ),
  );
}
run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => rmSync(scratch, { recursive: true, force: true }));
