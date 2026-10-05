import * as JSZip from 'jszip';

/**
 * The public trust summary of a published Crux Tool (ADR 0084).
 *
 * A Tool's full manifest is the creator's text — greeting, context, seed
 * documents, arbitrary keys a modified client might add — so the public side
 * never echoes it. It gets this fixed shape, rebuilt field by field from
 * allow-listed values, every time it is read.
 */
export interface ToolSummary {
  name: string;
  version?: string;
  /** The publishing author's username. */
  publisher?: string;
  upstreamUrl?: string;
  /** SPDX identifier (or simple SPDX expression). */
  license?: string;
  /** Size of the downloadable package. */
  sizeBytes?: number;
  /** What the editor may do, from a fixed vocabulary (TOOL_PERMISSIONS). */
  permissions?: ToolPermission[];
  /** Community editor code always runs inside the preview boundary (ADR 0071). */
  sandboxed: true;
}

/**
 * - `document`: reads and writes its own document inside the Crux.
 * - `file-drops`: receives files of the listed types dropped into the Crux.
 * - `public-edition`: a Crux made with it can be shared as a public page.
 */
export const TOOL_PERMISSIONS = [
  'document',
  'file-drops',
  'public-edition',
] as const;
export type ToolPermission = (typeof TOOL_PERMISSIONS)[number];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** Printable single-line text, bounded; anything else is dropped. */
function text(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = Array.from(value)
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return undefined;
  return clean.length > max ? clean.slice(0, max).trimEnd() : clean;
}

const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/;
const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const SPDX_ID = '[A-Za-z0-9][A-Za-z0-9.+-]{0,40}';
const LICENSE_RE = new RegExp(
  `^\\(?${SPDX_ID}\\)?( (AND|OR|WITH) \\(?${SPDX_ID}\\)?){0,3}$`,
);

function httpsUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 500) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password)
      return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

function sizeOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function permissionsOf(value: unknown): ToolPermission[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = TOOL_PERMISSIONS.filter((p) => value.includes(p));
  return out;
}

/** Permissions a validated manifest implies; the vocabulary is closed. */
export function permissionsFromManifest(
  manifest: Record<string, unknown>,
): ToolPermission[] {
  const out: ToolPermission[] = [];
  if (isRecord(manifest.document)) out.push('document');
  if (Array.isArray(manifest.routes) && manifest.routes.length)
    out.push('file-drops');
  if (manifest.share === true) out.push('public-edition');
  return out;
}

/** Keep only the summary's own fields, each validated. */
export function sanitizeToolSummary(
  input: unknown,
  publisher?: unknown,
): ToolSummary | undefined {
  if (!isRecord(input)) return undefined;
  const name = text(input.name, 80);
  if (!name) return undefined;
  const version =
    typeof input.version === 'string' && VERSION_RE.test(input.version)
      ? input.version
      : undefined;
  const who = [publisher, input.publisher].find(
    (value): value is string =>
      typeof value === 'string' && USERNAME_RE.test(value),
  );
  const license =
    typeof input.license === 'string' && LICENSE_RE.test(input.license)
      ? input.license
      : undefined;
  const summary: ToolSummary = { name, sandboxed: true };
  if (version) summary.version = version;
  if (who) summary.publisher = who;
  const upstreamUrl = httpsUrl(input.upstreamUrl);
  if (upstreamUrl) summary.upstreamUrl = upstreamUrl;
  if (license) summary.license = license;
  const sizeBytes = sizeOf(input.sizeBytes);
  if (sizeBytes !== undefined) summary.sizeBytes = sizeBytes;
  const permissions = permissionsOf(input.permissions);
  if (permissions) summary.permissions = permissions;
  return summary;
}

/** The summary fields a Tool manifest supplies (server-validated header or stored copy). */
export function summaryFromManifest(
  manifest: unknown,
  extra: { sizeBytes?: unknown; publisher?: unknown; license?: unknown } = {},
): ToolSummary | undefined {
  if (!isRecord(manifest)) return undefined;
  const info = isRecord(manifest.toolInfo) ? manifest.toolInfo : {};
  return sanitizeToolSummary(
    {
      name: manifest.name,
      version: manifest.releaseVersion,
      upstreamUrl: info.upstream,
      license: extra.license ?? manifest.license,
      sizeBytes: extra.sizeBytes,
      permissions: permissionsFromManifest(manifest),
      publisher: extra.publisher,
    },
    extra.publisher,
  );
}

/**
 * The public summary for a crux's meta, or undefined when it is not a
 * published Tool. Prefers the summary the host derived from the validated
 * package at publish time; falls back to the stored manifest for Tools
 * published before ADR 0084. Either way only allow-listed fields survive.
 */
export function toolSummaryOf(
  meta: Record<string, unknown>,
  publisher?: unknown,
): ToolSummary | undefined {
  const pkg = meta.toolPackage;
  if (!isRecord(pkg)) return undefined;
  if (isRecord(pkg.summary)) {
    const summary = sanitizeToolSummary(pkg.summary, publisher);
    if (summary && summary.sizeBytes === undefined) {
      const size = sizeOf(pkg.size);
      if (size !== undefined) summary.sizeBytes = size;
    }
    return summary;
  }
  return summaryFromManifest(meta.toolManifest, {
    sizeBytes: pkg.size,
    publisher,
  });
}

/* Licence detection from the package's own licence files. */

const MAX_LICENSE_BYTES = 256 * 1024;

/** Recognise a licence text by its standard wording; unknown → undefined. */
export function detectLicense(content: string): string | undefined {
  const t = content.slice(0, 20000).replace(/\s+/g, ' ');
  const has = (s: string) => t.toLowerCase().includes(s.toLowerCase());
  if (has('GNU AFFERO GENERAL PUBLIC LICENSE'))
    return has('Version 3') ? 'AGPL-3.0' : undefined;
  if (has('GNU LESSER GENERAL PUBLIC LICENSE'))
    return has('Version 2.1')
      ? 'LGPL-2.1'
      : has('Version 3')
        ? 'LGPL-3.0'
        : undefined;
  if (has('GNU LIBRARY GENERAL PUBLIC LICENSE')) return 'LGPL-2.0';
  if (has('GNU GENERAL PUBLIC LICENSE'))
    return has('Version 3')
      ? 'GPL-3.0'
      : has('Version 2')
        ? 'GPL-2.0'
        : undefined;
  if (has('Mozilla Public License') && has('2.0')) return 'MPL-2.0';
  if (has('Apache License') && has('Version 2.0')) return 'Apache-2.0';
  if (has('Permission is hereby granted, free of charge')) return 'MIT';
  if (has('ISC License') || has('Permission to use, copy, modify, and/or'))
    return 'ISC';
  if (has('Redistribution and use in source and binary forms'))
    return has('Neither the name') ? 'BSD-3-Clause' : 'BSD-2-Clause';
  if (has('This is free and unencumbered software released into the public'))
    return 'Unlicense';
  if (has('CC0 1.0 Universal')) return 'CC0-1.0';
  return undefined;
}

const LICENSE_FILE = /^(licen[cs]e|copying)(\.(md|txt|markdown))?$/i;

/** Root licence files first, then a `licenses/` folder; ordered for determinism. */
export function licenseCandidates(paths: string[]): string[] {
  const root = paths.filter((p) => LICENSE_FILE.test(p)).sort();
  const folder = paths.filter((p) => /^licen[cs]es\/[^/]+$/i.test(p)).sort();
  return [...root, ...folder];
}

/**
 * Read the validated package's header (never its code) and derive the
 * summary. Call only after `inspectToolPackage` accepted the buffer.
 */
export async function summaryFromToolPackage(
  data: Buffer,
  extra: { publisher?: string } = {},
): Promise<ToolSummary | undefined> {
  const zip = await JSZip.loadAsync(data);
  const header = zip.file('tool-package.json');
  if (!header) return undefined;
  const parsed = JSON.parse(await header.async('text')) as {
    tool?: Record<string, unknown>;
    files?: { path?: unknown; size?: unknown }[];
  };
  const files = Array.isArray(parsed.files) ? parsed.files : [];
  let license: string | undefined;
  for (const path of licenseCandidates(
    files
      .filter(
        (f) =>
          typeof f.path === 'string' &&
          typeof f.size === 'number' &&
          f.size <= MAX_LICENSE_BYTES,
      )
      .map((f) => f.path as string),
  )) {
    const entry = zip.file('files/' + path);
    if (!entry) continue;
    license = detectLicense(await entry.async('text'));
    if (license) break;
  }
  return summaryFromManifest(parsed.tool, {
    sizeBytes: data.length,
    publisher: extra.publisher,
    license,
  });
}
