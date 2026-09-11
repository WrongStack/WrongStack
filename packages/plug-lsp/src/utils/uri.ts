import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function pathToUri(filePath: string): string {
  return pathToFileURL(path.resolve(filePath)).toString();
}

export function uriToPath(uri: string): string {
  return fileURLToPath(uri);
}

/**
 * Canonical key for a `file:` URI, for matching a URI we sent against one a
 * server sent back. Servers do not agree on spelling: on Windows
 * `typescript-language-server` answers a `didOpen` for
 * `file:///C:/dir/index.ts` with diagnostics for `file:///c%3A/dir/index.ts`.
 * Comparing the raw strings silently drops every diagnostic, so always key
 * diagnostic buffers by this instead.
 *
 * Non-`file:` URIs (and anything unparseable) are returned unchanged — an
 * untranslatable scheme is still a stable identifier on its own.
 */
export function uriKey(uri: string, platform: NodeJS.Platform = process.platform): string {
  if (!uri.startsWith('file:')) return uri;
  try {
    const parsed = new URL(uri);
    if (parsed.hostname === '' && parsed.pathname === '/') return uri;
    const filePath = fileURLToPath(uri);
    // Windows paths are case-insensitive and the drive letter's case is not
    // meaningful; POSIX paths are case-sensitive and must not be folded.
    return platform === 'win32' ? path.resolve(filePath).toLowerCase() : path.resolve(filePath);
  } catch {
    return uri;
  }
}

export function displayPath(filePath: string, cwd: string): string {
  const rel = path.relative(cwd, filePath);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.replace(/\\/g, '/') : filePath;
}
