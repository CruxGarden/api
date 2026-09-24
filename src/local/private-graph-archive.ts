import JSZip = require('jszip');
import { createHash } from 'crypto';
import { z } from 'zod';
import { privateGraphSchema, PrivateGraph } from './portable-graph';
import type { DesktopContentStore } from './desktop-content';

const hash = (bytes: Uint8Array | string) =>
  createHash('sha256').update(bytes).digest('hex');
const archiveSchema = z
  .object({
    archiveVersion: z.literal(3),
    purpose: z.literal('private-backup'),
    graphVersion: z.literal(2),
    payloadVersion: z.literal(1),
    graphFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

/** Container only: graph capture/admission belongs to LocalGraphRuntime. No
 * reference-runtime downloads, filesystem paths or database writes happen here. */
export async function packPrivateGraph(
  graph: PrivateGraph,
  store: Pick<DesktopContentStore, 'read'>,
): Promise<Uint8Array> {
  const captured = privateGraphSchema.parse(JSON.parse(JSON.stringify(graph)));
  const read = store.read.bind(store);
  const json = JSON.stringify(captured);
  const zip = new JSZip();
  zip.file(
    'manifest.json',
    JSON.stringify({
      archiveVersion: 3,
      purpose: 'private-backup',
      graphVersion: 2,
      payloadVersion: 1,
      graphFingerprint: hash(json),
    }),
  );
  zip.file('graph.json', json);
  for (const fp of captured.fingerprints) {
    const bytes = await read(fp);
    if (!(bytes instanceof Uint8Array) || hash(bytes) !== fp)
      throw new Error(`Private archive content is missing or corrupt: ${fp}`);
    zip.file(`content/${fp}`, Uint8Array.from(bytes));
  }
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

export async function openPrivateGraphArchive(bytes: Uint8Array): Promise<{
  graph: PrivateGraph;
  content: Pick<DesktopContentStore, 'read'>;
}> {
  const zip = await JSZip.loadAsync(Uint8Array.from(bytes));
  const manifestFile = zip.file('manifest.json');
  const graphFile = zip.file('graph.json');
  if (!manifestFile || !graphFile)
    throw new Error('Use a current private Crux graph archive');
  const manifest = archiveSchema.parse(
    JSON.parse(await manifestFile.async('string')),
  );
  const graphBytes = await graphFile.async('uint8array');
  if (hash(graphBytes) !== manifest.graphFingerprint)
    throw new Error('Private graph failed its integrity check');
  const graph = privateGraphSchema.parse(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(graphBytes)),
  );
  const inventory = new Set(graph.fingerprints);
  if (inventory.size !== graph.fingerprints.length)
    throw new Error('Duplicate private archive content');
  const allowed = new Set([
    'manifest.json',
    'graph.json',
    ...graph.fingerprints.map((fp) => `content/${fp}`),
  ]);
  for (const entry of Object.values(zip.files)) {
    if (entry.dir && entry.name === 'content/') continue;
    if (
      !allowed.has(entry.name) ||
      (entry.unsafeOriginalName && entry.unsafeOriginalName !== entry.name)
    )
      throw new Error('Unexpected private archive entry');
  }
  for (const fp of inventory)
    if (!zip.file(`content/${fp}`))
      throw new Error(`Missing private archive content: ${fp}`);
  // No destination-cache fallback. Hashes and retained-tree meaning are checked
  // by the API before its destination transaction can commit.
  return {
    graph,
    content: {
      read: async (fp) =>
        inventory.has(fp)
          ? zip.file(`content/${fp}`)!.async('uint8array')
          : null,
    },
  };
}
