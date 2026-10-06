import * as JSZip from 'jszip';
import { createHash } from 'node:crypto';
import { inspectToolPackage } from './tool-package';

async function archive(count = 2) {
  const zip = new JSZip();
  const files = Array.from({ length: count }, (_, i) => ({
    path: i ? `runtime/${i}.js` : 'runtime/index.html',
    size: 1,
    mimeType: 'text/plain',
  }));
  for (const file of files)
    zip.file(`files/${file.path}`, 'x', { createFolders: false });
  const header = {
    format: 'crux-tool',
    version: 1,
    tool: { id: 'gdevelop-app', entryFile: 'runtime/index.html' },
    files,
  };
  zip.file('tool-package.json', JSON.stringify(header));
  return { zip, header };
}
const bytes = (zip: JSZip) =>
  zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });

describe('Crux Tool package inspection', () => {
  it('accepts 7,774 internal files as one object with one fingerprint', async () => {
    const { zip } = await archive(7774);
    const data = await bytes(zip);
    expect(await inspectToolPackage(data, 'gdevelop-app')).toEqual({
      version: 1,
      fingerprint: createHash('sha256').update(data).digest('hex'),
      size: data.length,
      fileCount: 7774,
      unpackedBytes: 7774,
    });
  }, 20000);

  it('accepts empty source files', async () => {
    const { zip, header } = await archive();
    header.files[1].size = 0;
    zip.file('files/runtime/1.js', '');
    zip.file('tool-package.json', JSON.stringify(header));
    expect(
      await inspectToolPackage(await bytes(zip), 'gdevelop-app'),
    ).toMatchObject({ fileCount: 2, unpackedBytes: 1 });
  });

  it('rejects a package for another tool', async () => {
    const { zip } = await archive();
    await expect(
      inspectToolPackage(await bytes(zip), 'p5-app'),
    ).rejects.toThrow(/Unsupported/);
  });

  it.each([
    '../outside',
    '/absolute',
    'a/../outside',
    'C:/outside',
    'a\\outside',
  ])('rejects unsafe paths: %s', async (path) => {
    const { zip, header } = await archive();
    header.files[1].path = path;
    zip.file('tool-package.json', JSON.stringify(header));
    await expect(
      inspectToolPackage(await bytes(zip), 'gdevelop-app'),
    ).rejects.toThrow(/Invalid package file/);
  });

  it('rejects undeclared files and mismatched expansion sizes', async () => {
    const { zip, header } = await archive();
    zip.file('files/unlisted.js', 'x', { createFolders: false });
    await expect(
      inspectToolPackage(await bytes(zip), 'gdevelop-app'),
    ).rejects.toThrow(/Unexpected/);
    zip.remove('files/unlisted.js');
    header.files[1].size = 500 * 1024 * 1024 + 1;
    zip.file('tool-package.json', JSON.stringify(header));
    await expect(
      inspectToolPackage(await bytes(zip), 'gdevelop-app'),
    ).rejects.toThrow(/Incomplete/);
  });
});
