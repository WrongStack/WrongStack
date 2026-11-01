/**
 * HQ static-serve — resolve and serve the built `@wrongstack/hq-next/dist`
 * dashboard (a Next.js static export). Mirrors the pattern in `webui-server/static-serve.ts` but for
 * the HQ app. Missing assets are reported to the caller, which serves a small
 * diagnostic shell instead of maintaining a second dashboard implementation.
 *
 * @module hq-static-serve
 */

import * as fs from 'node:fs';
import type * as http from 'node:http';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { wrongstackPackageJsonPath } from '@wrongstack/core/utils';

const requireFromHere = createRequire(import.meta.url);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  // Next.js static export: per-route React Server Component payloads.
  '.txt': 'text/plain; charset=utf-8',
};

let cachedDistDir: string | null | undefined;

/**
 * The HQ dashboard package: the Next.js static export. The retired Vite
 * dashboard (`webui-hq`) was folded into it and deleted.
 */
const HQ_UI_PACKAGE = 'hq-next';

/**
 * Resolve the HQ dashboard dist directory: the absolute path to the dashboard
 * package's `dist`, or `null` when it is not built. Result is cached for the
 * process lifetime.
 */
export function resolveHqDistDir(): string | null {
  if (cachedDistDir !== undefined) return cachedDistDir;
  cachedDistDir = resolvePackageDist(HQ_UI_PACKAGE);
  return cachedDistDir;
}

function resolvePackageDist(packageDir: string): string | null {
  // Strategy 1: resolve the package root via its package.json export. The
  // "." entry is absent (the package is an asset carrier — dist holds
  // index.html + assets), so resolving the bare specifier throws
  // ERR_PACKAGE_PATH_NOT_EXPORTED / MODULE_NOT_FOUND and, before this fix, HQ
  // silently ALWAYS fell back to the legacy inline HTML.
  try {
    const pkgJson = wrongstackPackageJsonPath(`@wrongstack/${packageDir}`, (id) =>
      requireFromHere.resolve(id),
    );
    const dist = path.join(path.dirname(pkgJson), 'dist');
    if (fs.existsSync(path.join(dist, 'index.html'))) return dist;
  } catch {
    /* fall through to strategy 2 */
  }

  // Strategy 2: walk up from this module looking for the workspace/installed
  // package under node_modules (also covers older installs whose package.json
  // exports map does not expose "./package.json").
  try {
    let dir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1'));
    for (let i = 0; i < 8; i++) {
      const candidate = path.join(dir, 'node_modules', '@wrongstack', packageDir, 'dist');
      if (fs.existsSync(path.join(candidate, 'index.html'))) return candidate;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* not found */
  }
  return null;
}

/** Check whether a resolved path stays inside the dist directory (no traversal). */
function isInsideDist(filePath: string, distDir: string): boolean {
  const rel = path.relative(distDir, filePath);
  // Canonical escape test: `..hidden` is a legal in-root first segment.
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

interface ServeStaticResult {
  handled: boolean;
}

function isMissingPath(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

async function readRegularFile(filePath: string): Promise<Buffer | null> {
  try {
    const info = await fs.promises.stat(filePath);
    if (!info.isFile()) return null;
    return await fs.promises.readFile(filePath);
  } catch (error) {
    if (isMissingPath(error)) return null;
    throw error;
  }
}

/**
 * Serve a static file from the HQ dist for an HTTP request. Handles the SPA
 * fallback (unknown routes → index.html). Returns `{handled:false}` when the
 * dist is not available (caller should serve the diagnostic shell) or the
 * path doesn't match a static asset.
 */
export async function serveHqStatic(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  urlPath: string,
  distDir: string,
): Promise<ServeStaticResult> {
  // Normalize: `/` → index.html; otherwise decode + resolve.
  const relPath = urlPath === '/' || urlPath === '' ? '/index.html' : urlPath;
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(relPath);
  } catch {
    return { handled: false };
  }
  const filePath = path.join(distDir, decodedPath);

  if (!isInsideDist(filePath, distDir)) {
    return { handled: false };
  }

  let servedPath = filePath;
  let data = await readRegularFile(filePath);
  if (data === null && path.extname(filePath) === '') {
    // A statically exported route (`/fleet/` → `fleet/index.html`). The Vite
    // dashboard has no such directories, so for it this is a cheap miss.
    servedPath = path.join(filePath, 'index.html');
    data = await readRegularFile(servedPath);
  }
  if (data === null) {
    const segmentPath = nextSegmentPayloadPath(filePath);
    if (segmentPath !== null && isInsideDist(segmentPath, distDir)) {
      servedPath = segmentPath;
      data = await readRegularFile(servedPath);
    }
  }
  if (data === null) {
    // A statically exported dashboard ships its own not-found page; rendering
    // the root page under an unknown URL would hydrate the wrong route. The
    // Vite dashboard has none and keeps the SPA fallback to index.html.
    const notFound = await readRegularFile(path.join(distDir, '404.html'));
    if (notFound !== null) {
      sendHtml(res, 404, notFound);
      return { handled: true };
    }
    const html = await readRegularFile(path.join(distDir, 'index.html'));
    if (html !== null) {
      sendHtml(res, 200, html);
      return { handled: true };
    }
    return { handled: false };
  }

  const ext = path.extname(servedPath).toLowerCase();
  if (ext === '.html') {
    sendHtml(res, 200, data);
    return { handled: true };
  }
  const mime = MIME[ext] ?? 'application/octet-stream';
  // Content-hashed bundles (Vite `assets/`, Next `_next/static/`) never change
  // under one URL. HTML and Next's route payloads (`index.txt`) are rewritten
  // by every build, so they must be revalidated or an upgrade serves a stale
  // shell pointing at chunks that no longer exist.
  const cacheControl =
    decodedPath.startsWith('/assets/') || decodedPath.startsWith('/_next/static/')
      ? 'public, max-age=31536000, immutable'
      : ext === '.txt'
        ? 'no-cache'
        : 'public, max-age=3600';
  res.writeHead(200, {
    'Content-Type': mime,
    'Cache-Control': cacheControl,
    'Content-Length': data.byteLength,
  });
  res.end(data);
  return { handled: true };
}

/**
 * HTML is rewritten by every build, so it is always revalidated. The router's
 * security headers are never widened here: HQ's `script-src 'self'` admits no
 * inline script, so the Next.js build moves its payload scripts into files
 * (`packages/hq-next/scripts/externalize-inline-scripts.mjs`). A build that
 * skipped that step fails closed — the page stays blank, nothing runs.
 */
function sendHtml(res: http.ServerResponse, status: number, html: Buffer): void {
  res.writeHead(status, {
    'Content-Type': MIME['.html']!,
    'Cache-Control': 'no-cache',
    'Content-Length': html.byteLength,
  });
  res.end(html);
}

/**
 * Next's client router prefetches one route segment at a time from
 * `<route>/__next.<group>.<segment>.__PAGE__.txt`, while the static export
 * writes that payload as `<route>/__next.<group>/<segment>/__PAGE__.txt`. Next's
 * own server does this mapping; a plain static host has to. Segment ids are
 * encoded, so the dots after the first are separators. Returns `null` for any
 * other file name.
 */
function nextSegmentPayloadPath(filePath: string): string | null {
  const name = path.basename(filePath);
  if (!name.startsWith('__next.') || !name.endsWith('.txt')) return null;
  const parts = name.slice(0, -'.txt'.length).split('.');
  if (parts.length < 3 || parts.some((part) => part === '' || part === '..')) return null;
  return path.join(
    path.dirname(filePath),
    `${parts[0]}.${parts[1]}`,
    ...parts.slice(2, -1),
    `${parts.at(-1)}.txt`,
  );
}
