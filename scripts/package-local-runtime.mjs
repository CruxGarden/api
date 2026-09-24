import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { isBuiltin } from 'node:module';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { dirname, resolve, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// Package compiled API code, not a second implementation or a sibling-repo
// runtime import. Native SQLite is supplied/rebuilt by the consuming host.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const output = join(root, 'build/local-runtime');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
}).trim();
const files = new Map();
const dependencies = new Map();

function external(specifier) {
  if (isBuiltin(specifier)) return;
  const name = specifier.startsWith('@')
    ? specifier.split('/').slice(0, 2).join('/')
    : specifier.split('/')[0];
  // Express appears only in public TypeScript declarations; do not add a web
  // server just to resolve those types.
  const dependency = name === 'express' ? '@types/express' : name;
  const version = lock.packages[`node_modules/${dependency}`]?.version;
  if (
    !version ||
    !(pkg.dependencies[dependency] || pkg.devDependencies[dependency])
  ) {
    throw new Error(`Undeclared local runtime dependency: ${dependency}`);
  }
  dependencies.set(dependency, version);
}

function visit(filename) {
  const key = relative(dist, filename);
  if (key.startsWith('..'))
    throw new Error(`Module escapes API build: ${filename}`);
  if (files.has(key)) return;
  const contents = readFileSync(filename, 'utf8');
  files.set(key, contents);
  const ast = ts.createSourceFile(
    filename,
    contents,
    ts.ScriptTarget.Latest,
    true,
  );
  function reference(specifier) {
    if (!specifier.startsWith('.')) return external(specifier);
    const target = resolve(dirname(filename), specifier);
    const candidates = [target + '.js', target + '.d.ts'];
    if (!candidates.some(existsSync))
      throw new Error(`Missing compiled module: ${target}`);
    for (const candidate of candidates)
      if (existsSync(candidate)) visit(candidate);
  }
  function scan(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      reference(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'require'
    ) {
      if (
        node.arguments.length !== 1 ||
        !ts.isStringLiteral(node.arguments[0])
      ) {
        throw new Error(`Unbounded require in ${key}`);
      }
      reference(node.arguments[0].text);
    }
    ts.forEachChild(node, scan);
  }
  scan(ast);
}

visit(join(dist, 'src/local/index.js'));
visit(join(dist, 'src/local/index.d.ts'));
// Loaded dynamically by Knex's SQLite dialect, so it isn't a static API import.
const sqliteVersion = pkg.dependencies['better-sqlite3'];
dependencies.delete('better-sqlite3');
// Peer requirements are explicit, even where decorators erase source imports.
for (const name of ['reflect-metadata', 'rxjs']) external(name);

// This directory is generated build output, never source or user data.
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
const hashes = {};
for (const [name, contents] of [...files].sort(([a], [b]) =>
  a.localeCompare(b),
)) {
  const target = join(output, 'dist', name);
  mkdirSync(dirname(target), { recursive: true });
  // Source maps are not distributed; compiled JS/declarations are the artifact.
  const shipped = contents.replace(/^\/\/# sourceMappingURL=.*$/gm, '');
  writeFileSync(target, shipped);
  hashes[name] = createHash('sha256').update(shipped).digest('hex');
}
const artifactHash = createHash('sha256')
  .update(JSON.stringify(hashes))
  .digest('hex');
const manifest = {
  name: '@cruxgarden/local-api',
  // Prefix hashes: an all-numeric hash beginning with zero is not a SemVer identifier.
  version: `0.0.0-unification.r${sourceRevision.slice(0, 12)}.h${artifactHash.slice(0, 8)}`,
  private: true,
  description:
    'Internal Crux Garden API deployment over the desktop working database',
  license: pkg.license,
  main: './dist/src/local/index.js',
  types: './dist/src/local/index.d.ts',
  exports: {
    '.': {
      types: './dist/src/local/index.d.ts',
      default: './dist/src/local/index.js',
    },
  },
  engines: { node: '>=22' },
  files: ['dist', 'provenance.json', 'LICENSE'],
  dependencies: Object.fromEntries(
    [...dependencies].sort(([a], [b]) => a.localeCompare(b)),
  ),
  peerDependencies: { 'better-sqlite3': sqliteVersion },
};
writeFileSync(
  join(output, 'package.json'),
  JSON.stringify(manifest, null, 2) + '\n',
);
writeFileSync(
  join(output, 'provenance.json'),
  JSON.stringify({ sourceRevision, artifactHash, files: hashes }, null, 2) +
    '\n',
);
if (existsSync(join(root, 'LICENSE')))
  writeFileSync(join(output, 'LICENSE'), readFileSync(join(root, 'LICENSE')));
console.log(
  JSON.stringify(
    {
      output,
      version: manifest.version,
      files: files.size,
      dependencies: manifest.dependencies,
    },
    null,
    2,
  ),
);
