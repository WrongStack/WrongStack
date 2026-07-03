/**
 * HQ static-serve — resolve and serve the built `@wrongstack/webui-hq/dist`
 * dashboard. Mirrors the pattern in `webui-server/static-serve.ts` but for
 * the HQ app. Falls back to the inline `HQ_HTML` when the dist is unbuilt so
 * HQ is always functional.
 *
 * @module hq-static-serve
 */
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as http from 'node:http';

const requireFromHere = createRequire(import.meta.url);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

let cachedDistDir: string | null | undefined;

/**
 * Resolve the HQ dashboard dist directory. Returns the absolute path to
 * `@wrongstack/webui-hq/dist`, or `null` when the package/dist is not
 * present (e.g. unbuilt). Result is cached for the process lifetime.
 */
export function resolveHqDistDir(): string | null {
  if (cachedDistDir !== undefined) return cachedDistDir;
  try {
    // Resolve the package's index entry, then walk up to the package root's dist.
    const entry = requireFromHere.resolve('@wrongstack/webui-hq');
    // entry is typically <pkg>/dist/index.js → dist dir is path.dirname(entry).
    const dir = path.dirname(entry);
    if (fs.existsSync(path.join(dir, 'index.html'))) {
      cachedDistDir = dir;
      return dir;
    }
    // Maybe entry is the package root; try dist subdir.
    const distSub = path.join(path.dirname(entry), 'dist');
    if (fs.existsSync(path.join(distSub, 'index.html'))) {
      cachedDistDir = distSub;
      return distSub;
    }
  } catch {
    /* package not installed */
  }
  cachedDistDir = null;
  return null;
}

/** Check whether a resolved path stays inside the dist directory (no traversal). */
function isInsideDist(filePath: string, distDir: string): boolean {
  const rel = path.relative(distDir, filePath);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export interface ServeStaticResult {
  handled: boolean;
}

/**
 * Serve a static file from the HQ dist for an HTTP request. Handles the SPA
 * fallback (unknown routes → index.html). Returns `{handled:false}` when the
 * dist is not available (caller should serve the inline fallback) or the
 * path doesn't match a static asset.
 */
export function serveHqStatic(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  urlPath: string,
  distDir: string,
): ServeStaticResult {
  // Normalize: `/` → index.html; otherwise decode + resolve.
  const relPath = urlPath === '/' || urlPath === '' ? '/index.html' : urlPath;
  const filePath = path.join(distDir, decodeURIComponent(relPath));

  if (!isInsideDist(filePath, distDir)) {
    return { handled: false };
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    // SPA fallback: serve index.html for client-side routes.
    const indexPath = path.join(distDir, 'index.html');
    if (fs.existsSync(indexPath)) {
      const html = fs.readFileSync(indexPath, 'utf8');
      res.writeHead(200, { 'Content-Type': MIME['.html']! });
      res.end(html);
      return { handled: true };
    }
    return { handled: false };
  }

  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME[ext] ?? 'application/octet-stream';
  const data = fs.readFileSync(filePath);
  res.writeHead(200, { 'Content-Type': mime });
  res.end(data);
  return { handled: true };
}
