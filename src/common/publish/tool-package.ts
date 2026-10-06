import { BadRequestException } from '@nestjs/common';
import * as JSZip from 'jszip';
import { createHash } from 'node:crypto';

export const TOOL_PACKAGE_PATH = '_crux/tool-package.zip';
const MAX_BYTES = 500 * 1024 * 1024;
const safePath = (path: unknown): path is string =>
  typeof path === 'string' &&
  !!path &&
  path.length <= 1000 &&
  !path.includes('\\') &&
  !Array.from(path).some((char) => char.charCodeAt(0) < 32) &&
  !path.startsWith('/') &&
  !/^[A-Za-z]:/.test(path) &&
  path.split('/').every((part) => !!part && part !== '.' && part !== '..');
const size = async (file: JSZip.JSZipObject): Promise<number> => {
  // JSZip represents empty files as Promise<''>, without a compressed record.
  const data = await (
    file as unknown as { _data: { uncompressedSize: number } | Promise<string> }
  )._data;
  return data === ''
    ? 0
    : typeof data === 'object'
      ? data.uncompressedSize
      : NaN;
};

/** Inspect the bounded manifest/ZIP directory; never extract or execute uploaded tool code. */
export async function inspectToolPackage(data: Buffer, expectedId: unknown) {
  try {
    if (!data.length || data.length > MAX_BYTES)
      throw new Error('Invalid package size');
    const zip = await JSZip.loadAsync(data);
    const header = zip.file('tool-package.json');
    if (
      !header ||
      header.unsafeOriginalName !== 'tool-package.json' ||
      (await size(header)) > 4 * 1024 * 1024
    )
      throw new Error('Missing package manifest');
    const parsed = JSON.parse(await header.async('text')) as {
      format: string;
      version: number;
      tool: { id: string; entryFile: string; releaseVersion?: string };
      files: { path: string; size: number; mimeType: string }[];
    };
    if (
      parsed.format !== 'crux-tool' ||
      parsed.version !== 1 ||
      !parsed.tool ||
      parsed.tool.id !== expectedId ||
      !safePath(parsed.tool.entryFile) ||
      !Array.isArray(parsed.files) ||
      !parsed.files.length ||
      parsed.files.length > 10000
    )
      throw new Error('Unsupported tool package');
    const paths = new Set<string>();
    let unpackedBytes = 0;
    for (const file of parsed.files) {
      if (
        !safePath(file.path) ||
        paths.has(file.path) ||
        !Number.isSafeInteger(file.size) ||
        file.size < 0 ||
        typeof file.mimeType !== 'string'
      )
        throw new Error('Invalid package file');
      paths.add(file.path);
      unpackedBytes += file.size;
      const entry = zip.file('files/' + file.path);
      if (
        !entry ||
        entry.unsafeOriginalName !== 'files/' + file.path ||
        (await size(entry)) !== file.size
      )
        throw new Error('Incomplete tool package');
    }
    if (
      unpackedBytes > MAX_BYTES ||
      !paths.has(parsed.tool.entryFile) ||
      Object.values(zip.files).filter((f) => !f.dir).length !== paths.size + 1
    )
      throw new Error('Unexpected package files or expanded size');
    return {
      version: 1 as const,
      fingerprint: createHash('sha256').update(data).digest('hex'),
      size: data.length,
      fileCount: paths.size,
      unpackedBytes,
    };
  } catch (error) {
    throw new BadRequestException(
      `Invalid Crux Tool package: ${(error as Error).message}`,
    );
  }
}
