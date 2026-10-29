/**
 * Dead-code HTTP handlers — the WebUI's surface over the dead-code engine.
 *
 *   POST /api/deadcode/scan     { paths?, includePublicApi? }      → findings
 *   POST /api/deadcode/preview  { ids }                            → exact diffs, nothing written
 *   POST /api/deadcode/apply    { ids, verify?, expectedRevision? } → re-scan, write, typecheck, rollback on failure
 *   POST /api/deadcode/undo     { backupId, force? }               → restore a fix's backup
 *   GET  /api/deadcode/backups                                     → available backups
 *
 * Findings are addressed by id and every write re-scans first, so a UI holding
 * an old report can never patch files at stale offsets.
 */

import type * as http from 'node:http';
import { sanitizeApiError } from '@wrongstack/core/security';
import {
  analyzeDeadCode,
  applyDeadCodeFixes,
  listDeadCodeBackups,
  planDeadCodeFixes,
  undoDeadCodeFix,
} from '@wrongstack/tools/dead-code';
import { errMessage } from './ws-utils.js';

interface DeadCodeHandlerDeps {
  projectRoot: string;
}

/** Max accepted POST body size (1 MiB) — requests carry ids, not reports. */
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_IDS = 5000;

function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        req.destroy(new Error('Request body too large'));
        reject(new Error('Request body exceeds 1 MiB limit'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        const parsed = JSON.parse(raw) as unknown;
        resolve(
          parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {},
        );
      } catch {
        reject(new BadRequest('Invalid JSON body'));
      }
    });
    req.on('error', (err) => reject(err));
  });
}

class BadRequest extends Error {}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function stringArray(v: unknown, field: string, max = MAX_IDS): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string') || v.length > max) {
    throw new BadRequest(`${field} must be an array of at most ${max} strings`);
  }
  return v as string[];
}

function projectRelativePaths(v: unknown): string[] {
  const paths = stringArray(v, 'paths', 200);
  for (const p of paths) {
    const norm = p.replace(/\\/g, '/');
    if (norm.startsWith('/') || /^[a-zA-Z]:/.test(norm) || norm.split('/').includes('..')) {
      throw new BadRequest(`paths must be project-relative: "${p}"`);
    }
  }
  return paths;
}

/** Routes every `/api/deadcode/*` request. Returns false for unknown paths. */
export async function handleDeadCodeRequest(
  pathname: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: DeadCodeHandlerDeps,
): Promise<boolean> {
  const route = pathname.slice('/api/deadcode/'.length);
  const method = req.method ?? 'GET';
  try {
    if (route === 'backups' && method === 'GET') {
      send(res, 200, { backups: listDeadCodeBackups(deps.projectRoot) });
      return true;
    }
    if (method !== 'POST') return false;
    switch (route) {
      case 'scan': {
        const body = await readJsonBody(req);
        const {
          nodes: _nodes,
          fileHashes: _hashes,
          ...result
        } = await analyzeDeadCode(deps.projectRoot, {
          paths: projectRelativePaths(body.paths),
          includePublicApi: body.includePublicApi === true,
        });
        send(res, 200, result);
        return true;
      }
      case 'preview': {
        const body = await readJsonBody(req);
        const ids = stringArray(body.ids, 'ids');
        if (ids.length === 0) throw new BadRequest('ids must not be empty');
        send(res, 200, await planDeadCodeFixes(deps.projectRoot, ids));
        return true;
      }
      case 'apply': {
        const body = await readJsonBody(req);
        const ids = stringArray(body.ids, 'ids');
        if (ids.length === 0) throw new BadRequest('ids must not be empty');
        const verify = body.verify === 'none' ? 'none' : 'typecheck';
        if (body.expectedRevision !== undefined && typeof body.expectedRevision !== 'string')
          throw new BadRequest('expectedRevision must be a string');
        send(
          res,
          200,
          await applyDeadCodeFixes(deps.projectRoot, ids, {
            verify,
            ...(typeof body.expectedRevision === 'string'
              ? { expectedRevision: body.expectedRevision }
              : {}),
          }),
        );
        return true;
      }
      case 'undo': {
        const body = await readJsonBody(req);
        if (typeof body.backupId !== 'string' || !/^[\w.-]+$/.test(body.backupId)) {
          throw new BadRequest('backupId is required');
        }
        send(
          res,
          200,
          undoDeadCodeFix(deps.projectRoot, body.backupId, { force: body.force === true }),
        );
        return true;
      }
      default:
        return false;
    }
  } catch (err) {
    if (err instanceof BadRequest) {
      send(res, 400, { error: err.message });
      return true;
    }
    // Detail stays server-side; the body carries only a category.
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'deadcode.request_failed',
        route,
        message: errMessage(err),
        timestamp: new Date().toISOString(),
      }),
    );
    send(res, 500, { error: `Dead-code ${route} failed`, detail: sanitizeApiError(err) });
    return true;
  }
}
