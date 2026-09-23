import { createHash } from 'crypto';
import type { DesktopContentStore } from './desktop-content';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface FileEntry {
  id: string;
  path: string;
  fingerprint: string;
  size: number;
  mimeType: string;
  encoding: string;
  mode: number;
  attributes: { [key: string]: Json };
}
export type FileEdit = { put: FileEntry } | { remove: string };
type Ref = { hash: string; count: number };
type Child = Ref & { digit: string };
type Node =
  | { version: 1; type: 'leaf'; entries: FileEntry[] }
  | { version: 1; type: 'branch'; children: Child[] };
const LIMIT = 64;
const sha = (bytes: Uint8Array | string) =>
  createHash('sha256').update(bytes).digest('hex');
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const fail = (message: string): never => {
  throw new Error(message);
};
const fingerprint = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const plain = (value: unknown): value is Record<string, unknown> =>
  !!value &&
  typeof value === 'object' &&
  (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null);

/** Explicit format-1 JSON rules, not a dependency on locale or insertion order. */
function canonical(value: unknown, ancestors = new Set<object>()): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value))
    return JSON.stringify(value);
  if (!Array.isArray(value) && !plain(value))
    return fail('Manifest values must be finite JSON');
  if (ancestors.has(value)) return fail('Cyclic manifest value');
  ancestors.add(value);
  let encoded: string;
  if (Array.isArray(value)) {
    // Sparse arrays cannot silently turn missing entries into null.
    const parts: string[] = [];
    for (let i = 0; i < value.length; i++)
      parts.push(canonical(value[i], ancestors));
    encoded = `[${parts.join(',')}]`;
  } else
    encoded = `{${Object.keys(value)
      .sort(compare)
      .map(
        (key) => `${JSON.stringify(key)}:${canonical(value[key], ancestors)}`,
      )
      .join(',')}}`;
  ancestors.delete(value);
  return encoded;
}
function validPath(path: unknown): asserts path is string {
  if (
    typeof path !== 'string' ||
    !path ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.split('/').some((p) => !p || p === '.' || p === '..') ||
    Buffer.from(path).toString('utf8') !== path
  )
    fail('Invalid manifest path');
}
function keys(value: Record<string, unknown>, expected: string[]) {
  if (
    Object.keys(value).sort(compare).join(',') !==
    expected.sort(compare).join(',')
  )
    fail('Invalid manifest fields');
}
function validateEntry(value: unknown): asserts value is FileEntry {
  if (!plain(value)) return fail('Invalid file entry');
  keys(value, [
    'id',
    'path',
    'fingerprint',
    'size',
    'mimeType',
    'encoding',
    'mode',
    'attributes',
  ]);
  validPath(value.path);
  if (
    typeof value.id !== 'string' ||
    !value.id ||
    !fingerprint(value.fingerprint) ||
    !Number.isSafeInteger(value.size) ||
    Number(value.size) < 0 ||
    !Number.isSafeInteger(value.mode) ||
    Number(value.mode) < 0 ||
    Number(value.mode) > 0o7777 ||
    typeof value.mimeType !== 'string' ||
    typeof value.encoding !== 'string' ||
    !plain(value.attributes)
  )
    fail('Invalid file entry fields');
  canonical(value.attributes);
}
function size(node: Node) {
  return node.type === 'leaf'
    ? node.entries.length
    : node.children.reduce((n, child) => n + child.count, 0);
}

/** Isolated format kernel (ADR 0059). No graph commit, migration or garbage collection. */
export class FileManifest {
  constructor(private readonly store: DesktopContentStore) {}

  private async bytes(id: string): Promise<Uint8Array> {
    if (!fingerprint(id)) return fail('Invalid content fingerprint');
    const bytes = await this.store.read(id);
    if (bytes === null) return fail(`Missing content: ${id}`);
    if (!(bytes instanceof Uint8Array) || sha(bytes) !== id)
      return fail(`Content integrity failed: ${id}`);
    return bytes;
  }

  private async read(ref: Ref | string, prefix: string): Promise<Node> {
    const bytes = await this.bytes(typeof ref === 'string' ? ref : ref.hash);
    const text = Buffer.from(bytes).toString('utf8');
    if (!Buffer.from(text).equals(bytes)) return fail('Invalid manifest UTF-8');
    const value: unknown = JSON.parse(text);
    if (!plain(value) || value.version !== 1)
      return fail('Unknown file manifest version');
    if (canonical(value) !== text) return fail('Noncanonical file manifest');
    let node: Node;
    if (value.type === 'leaf') {
      keys(value, ['version', 'type', 'entries']);
      if (!Array.isArray(value.entries) || value.entries.length > LIMIT)
        return fail('Invalid manifest leaf');
      let prior: string | undefined;
      for (const entry of value.entries) {
        validateEntry(entry);
        if (
          !sha(entry.path).startsWith(prefix) ||
          (prior !== undefined && compare(prior, entry.path) >= 0)
        )
          return fail('Invalid manifest path partition');
        prior = entry.path;
      }
      node = value as Node;
    } else if (value.type === 'branch') {
      keys(value, ['version', 'type', 'children']);
      if (
        prefix.length >= 64 ||
        !Array.isArray(value.children) ||
        !value.children.length ||
        value.children.length > 16
      )
        return fail('Invalid manifest branch');
      let prior = '';
      let total = 0;
      for (const child of value.children) {
        if (!plain(child)) return fail('Invalid manifest child');
        keys(child, ['digit', 'hash', 'count']);
        if (
          typeof child.digit !== 'string' ||
          !/^[a-f0-9]$/.test(child.digit) ||
          child.digit <= prior ||
          !fingerprint(child.hash) ||
          !Number.isSafeInteger(child.count) ||
          Number(child.count) < 1
        )
          return fail('Invalid manifest child');
        prior = child.digit;
        total += Number(child.count);
      }
      if (!Number.isSafeInteger(total) || total <= LIMIT)
        return fail('Invalid manifest branch count');
      node = value as Node;
    } else return fail('Unknown file manifest node');
    if (typeof ref !== 'string' && size(node) !== ref.count)
      return fail('Manifest child count mismatch');
    return node;
  }

  private async save(node: Node): Promise<Ref> {
    const bytes = Buffer.from(canonical(node));
    const hash = sha(bytes);
    const present = await this.store.read(hash);
    if (present === null) await this.store.write(hash, bytes);
    await this.bytes(hash); // Detect refused writes, corrupt existing objects and silent write loss.
    return { hash, count: size(node) };
  }

  private async build(entries: FileEntry[], prefix: string): Promise<Ref> {
    if (entries.length <= LIMIT)
      return this.save({
        version: 1,
        type: 'leaf',
        entries: entries.sort((a, b) => compare(a.path, b.path)),
      });
    if (prefix.length >= 64)
      return fail('Manifest path hash collision limit exceeded');
    const groups = new Map<string, FileEntry[]>();
    for (const entry of entries) {
      const digit = sha(entry.path)[prefix.length];
      const group = groups.get(digit) ?? [];
      group.push(entry);
      groups.set(digit, group);
    }
    const children: Child[] = [];
    for (const [digit, group] of [...groups].sort(([a], [b]) => compare(a, b)))
      children.push({ digit, ...(await this.build(group, prefix + digit)) });
    return this.save({ version: 1, type: 'branch', children });
  }

  private async collect(
    ref: Ref | string,
    prefix: string,
  ): Promise<FileEntry[]> {
    const node = await this.read(ref, prefix);
    if (node.type === 'leaf') return node.entries;
    const entries: FileEntry[] = [];
    for (const child of node.children)
      entries.push(...(await this.collect(child, prefix + child.digit)));
    return entries;
  }

  private async update(
    ref: Ref | null,
    prefix: string,
    edits: FileEdit[],
  ): Promise<Ref> {
    const node = ref
      ? await this.read(ref, prefix)
      : { version: 1 as const, type: 'leaf' as const, entries: [] };
    if (node.type === 'leaf') {
      const entries = new Map(node.entries.map((entry) => [entry.path, entry]));
      for (const edit of edits) {
        if ('put' in edit) entries.set(edit.put.path, edit.put);
        else entries.delete(edit.remove);
      }
      return this.build([...entries.values()], prefix);
    }
    const groups = new Map<string, FileEdit[]>();
    for (const edit of edits) {
      const digit = sha('put' in edit ? edit.put.path : edit.remove)[
        prefix.length
      ];
      const group = groups.get(digit) ?? [];
      group.push(edit);
      groups.set(digit, group);
    }
    const children = new Map(
      node.children.map((child) => [child.digit, child]),
    );
    for (const [digit, group] of groups) {
      const changed = await this.update(
        children.get(digit) ?? null,
        prefix + digit,
        group,
      );
      if (changed.count) children.set(digit, { digit, ...changed });
      else children.delete(digit);
    }
    const sorted = [...children.values()].sort((a, b) =>
      compare(a.digit, b.digit),
    );
    if (sorted.reduce((n, child) => n + child.count, 0) <= LIMIT) {
      const entries: FileEntry[] = [];
      for (const child of sorted)
        entries.push(...(await this.collect(child, prefix + child.digit)));
      return this.build(entries, prefix);
    }
    return this.save({ version: 1, type: 'branch', children: sorted });
  }

  async apply(root: string | null, edits: FileEdit[]): Promise<string> {
    // Validation/encoding happen before the first await; callers cannot redirect queued edits.
    if (!Array.isArray(edits)) return fail('Invalid manifest edits');
    const captured = JSON.parse(canonical(edits)) as FileEdit[];
    const paths = new Set<string>();
    for (const edit of captured) {
      if (!plain(edit)) return fail('Invalid manifest edit');
      if ('put' in edit) {
        keys(edit, ['put']);
        validateEntry(edit.put);
      } else {
        keys(edit, ['remove']);
        validPath(edit.remove);
      }
      const path = 'put' in edit ? edit.put.path : edit.remove;
      if (paths.has(path)) return fail('Duplicate manifest edit path');
      paths.add(path);
    }
    for (const edit of captured)
      if ('put' in edit) {
        const bytes = await this.bytes(edit.put.fingerprint);
        if (bytes.byteLength !== edit.put.size)
          return fail('File size mismatch');
      }
    const ref =
      root === null
        ? null
        : { hash: root, count: size(await this.read(root, '')) };
    return (await this.update(ref, '', captured)).hash;
  }

  async get(root: string, path: string): Promise<FileEntry | null> {
    validPath(path);
    const key = sha(path);
    let prefix = '';
    let ref: Ref | string = root;
    for (;;) {
      const node = await this.read(ref, prefix);
      if (node.type === 'leaf')
        return node.entries.find((entry) => entry.path === path) ?? null;
      const digit = key[prefix.length];
      const child = node.children.find(
        (candidate) => candidate.digit === digit,
      );
      if (!child) return null;
      ref = child;
      prefix += digit;
    }
  }

  /** Full projection for isolated validation/export; callers must not use this for every UI lookup. */
  async entries(root: string): Promise<FileEntry[]> {
    return (await this.collect(root, '')).sort((a, b) =>
      compare(a.path, b.path),
    );
  }

  /** Complete import/retention walk, including file bytes. No deletion is performed. */
  async verify(root: string): Promise<string[]> {
    const references = new Set<string>();
    const walk = async (ref: Ref | string, prefix: string): Promise<void> => {
      const node = await this.read(ref, prefix);
      references.add(typeof ref === 'string' ? ref : ref.hash);
      if (node.type === 'branch') {
        for (const child of node.children)
          await walk(child, prefix + child.digit);
      } else
        for (const entry of node.entries) {
          const bytes = await this.bytes(entry.fingerprint);
          if (bytes.byteLength !== entry.size)
            return fail('File size mismatch');
          references.add(entry.fingerprint);
        }
    };
    await walk(root, '');
    return [...references].sort(compare);
  }
}
