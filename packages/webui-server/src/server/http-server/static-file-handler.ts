import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as path from 'node:path';
import {
  buildCspHeader,
  injectWsConfig,
  isInsideDist,
  MIME_TYPES,
  setStaticSecurityHeaders,
} from './security-helpers.js';

export async function handleStaticFileRequest(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  distDir: string,
  url: URL,
  opts: {
    publicWsUrl?: string | undefined;
    host: string;
  },
  port: number,
  shouldSetAuthCookie: boolean,
): Promise<void> {
  let filePath: string;

  if (url.pathname === '/' || url.pathname === '') {
    filePath = path.join(distDir, 'index.html');
  } else {
    filePath = path.join(distDir, url.pathname);
  }

  const resolvedPath = path.resolve(filePath);
  if (!isInsideDist(resolvedPath, distDir)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  const ext = path.extname(resolvedPath);
  const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';
  res.setHeader('Content-Type', contentType);
  setStaticSecurityHeaders(res);

  if (ext === '.html') {
    if (!shouldSetAuthCookie) res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Content-Security-Policy', buildCspHeader(opts.publicWsUrl, opts.host, port));
    const html = await fs.readFile(resolvedPath, 'utf8');
    res.writeHead(200);
    res.end(injectWsConfig(html, { publicWsUrl: opts.publicWsUrl }));
    return;
  }

  if (!shouldSetAuthCookie) {
    res.setHeader(
      'Cache-Control',
      url.pathname.startsWith('/assets/')
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=3600',
    );
  }
  const fileContent = await fs.readFile(resolvedPath);
  res.writeHead(200);
  res.end(fileContent);
}

export async function handleSpaFallback(
  res: http.ServerResponse,
  distDir: string,
  opts: {
    publicWsUrl?: string | undefined;
    host: string;
  },
  port: number,
): Promise<void> {
  try {
    const html = await fs.readFile(path.join(distDir, 'index.html'), 'utf8');
    setStaticSecurityHeaders(res);
    res.writeHead(200, {
      'Content-Type': 'text/html',
      'Content-Security-Policy': buildCspHeader(opts.publicWsUrl, opts.host, port),
    });
    res.end(injectWsConfig(html, { publicWsUrl: opts.publicWsUrl }));
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}
