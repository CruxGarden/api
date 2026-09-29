const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { mkdtempSync, readFileSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { randomUUID, createHash } = require('node:crypto');

// Accept an installed package path to check the exact packed artifact in a
// standalone consumer (including Electron), not ts-node or source resolution.
const packageRoot = resolve(
  process.argv[2] || join(__dirname, '../build/local-runtime'),
);
const load = createRequire(join(packageRoot, 'package.json'));
const manifest = load('./package.json');
const provenance = load('./provenance.json');
for (const [file, hash] of Object.entries(provenance.files)) {
  assert.equal(
    createHash('sha256')
      .update(readFileSync(join(packageRoot, 'dist', file)))
      .digest('hex'),
    hash,
  );
}
assert.equal(manifest.private, true);
assert.equal(
  manifest.peerDependencies['better-sqlite3'],
  load('better-sqlite3/package.json').version,
  'The runtime must use its declared native SQLite version',
);
for (const name of Object.keys(manifest.dependencies)) {
  assert.ok(!/aws|redis|stripe|isolated-vm|anthropic|openai/.test(name), name);
}
const { LocalGraphRuntime } = load(packageRoot);
const Database = load('better-sqlite3');
const scratch = mkdtempSync(join(tmpdir(), 'crux-local-artifact-'));
const filename = join(scratch, 'graph.db');
const seed = new Database(filename);
seed.exec(
  readFileSync(join(__dirname, '../test/fixtures/desktop-schema.sql'), 'utf8'),
);
seed.close();
const authorId = randomUUID();
const homeId = randomUUID();
const input = () => ({ slug: randomUUID(), authorId, homeId, kind: 'garden' });

async function check() {
  let runtime;
  try {
    runtime = await LocalGraphRuntime.open(filename);
    const { root, child } = await runtime.execute(async ({ crux }) => {
      const root = await crux.create(input());
      const child = await crux.create(input());
      await crux.createDimension(root.id, {
        targetId: child.id,
        type: 'garden',
        kind: 'membership',
        authorId,
        homeId,
      });
      return { root, child };
    });
    assert.equal(root.visibility, 'private');
    assert.equal((await runtime.all('SELECT * FROM cruxes')).length, 2);
    await assert.rejects(
      runtime.execute(async ({ crux }) => {
        await crux.create(input());
        throw new Error('abort command');
      }),
      /abort command/,
    );
    assert.equal((await runtime.all('SELECT * FROM cruxes')).length, 2);
    const restored = join(scratch, 'restored.db');
    writeFileSync(restored, Buffer.from(await runtime.exportDatabase()));
    await runtime.close();
    runtime = await LocalGraphRuntime.open(restored);
    assert.equal(
      (await runtime.execute(({ crux }) => crux.findById(child.id))).id,
      child.id,
    );
    assert.equal(
      (
        await runtime.all('SELECT * FROM dimensions WHERE source_id = ?', [
          root.id,
        ])
      ).length,
      1,
    );
    // Opening the local API must not discover hosted configuration or connect
    // to hosted providers, even though the shared DbService retains its hosted
    // fallback for the server deployment.
    const loaded = Object.keys(require.cache);
    assert.ok(!loaded.some((p) => p.endsWith('/knexfile.js')));
    assert.ok(
      !loaded.some((p) => /\/node_modules\/(pg|redis|stripe)\//.test(p)),
    );
    console.log(
      JSON.stringify({
        ok: true,
        version: manifest.version,
        node: process.versions.node,
        electron: process.versions.electron || null,
        abi: process.versions.modules,
        cruxes: 2,
        dimensions: 1,
        rollback: true,
        exportRestart: true,
      }),
    );
  } finally {
    await runtime?.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}
check().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
