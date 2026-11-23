import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { loadGitignoreMatcher } from '@wrongstack/tools/codebase-index';
import type { WebSocket } from 'ws';
import { resolveFileInsideProject, withSessionEcho } from './file-handler-helpers.js';
import { isHiddenEntry, SKIP_DIRS } from './file-picker.js';
import { resolveWorkingDirInsideProject } from './path-containment.js';
import { foldCaseSameLength } from './search-fold.js';
import { errMessage, messageSessionId, send } from './ws-utils.js';

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_BYTES = 32 * MAX_FILE_BYTES;
const MAX_ENTRIES = 20_000;
const MAX_FILES = 5_000;
const MAX_MS = 5_000;
interface Hit {
  path: string;
  line: number;
  column: number;
  preview: string;
}

/** Bounded, literal UTF-8 source search; never dispatches an agent or transfers whole files. */
export async function handleFileContentSearch(
  ws: WebSocket,
  msg: { payload?: unknown },
  projectRoot: string,
): Promise<void> {
  const sessionId = messageSessionId(msg);
  const reply = (value: Record<string, unknown>) =>
    send(ws, { type: 'files.search', payload: withSessionEcho(value, sessionId) });
  try {
    const input = msg.payload as Record<string, unknown> | undefined;
    const query = input?.['query'];
    if (
      typeof query !== 'string' ||
      query.length < 1 ||
      query.length > 200 ||
      /[\r\n\0]/.test(query)
    )
      throw Error('Enter a literal search between 1 and 200 characters on one line.');
    const scope = typeof input?.['path'] === 'string' ? input['path'] : '.';
    const root = await resolveWorkingDirInsideProject(projectRoot, scope || '.');
    const matchCase = input?.['matchCase'] === true;
    const includeIgnored = input?.['includeIgnored'] === true;
    const limit = Math.max(
      1,
      Math.min(
        500,
        typeof input?.['limit'] === 'number' && Number.isSafeInteger(input['limit'])
          ? input['limit']
          : 200,
      ),
    );
    const needle = matchCase ? query : foldCaseSameLength(query);
    const queryLength = query.length;
    const ignored = await loadGitignoreMatcher(projectRoot);
    const hits: Hit[] = [];
    const reasons = new Set<string>();
    const skipped = { binary: 0, oversized: 0, unreadable: 0, links: 0, depth: 0 };
    let visitedEntries = 0,
      scannedFiles = 0,
      bytesRead = 0;
    const started = performance.now();
    const exhausted = () => {
      if (performance.now() - started >= MAX_MS) reasons.add('time');
      if (visitedEntries >= MAX_ENTRIES) reasons.add('entries');
      if (scannedFiles >= MAX_FILES) reasons.add('files');
      if (bytesRead >= MAX_BYTES) reasons.add('bytes');
      if (hits.length >= limit) reasons.add('matches');
      return reasons.size > 0;
    };
    async function walk(directory: string, depth: number): Promise<void> {
      if (depth > 30) {
        skipped.depth++;
        return;
      }
      // opendir streams directory entries rather than allocating an unbounded listing.
      const dir = await fs.opendir(directory).catch(() => {
        skipped.unreadable++;
        return null;
      });
      if (!dir) return;
      for await (const entry of dir) {
        if (exhausted()) break;
        visitedEntries++;
        if (isHiddenEntry(entry.name) || SKIP_DIRS.has(entry.name)) continue;
        if (entry.isSymbolicLink()) {
          skipped.links++;
          continue;
        }
        const absolute = path.join(directory, entry.name);
        const relative = path.relative(projectRoot, absolute).replaceAll('\\', '/');
        if (!includeIgnored && ignored(relative, entry.isDirectory())) continue;
        if (entry.isDirectory()) {
          await walk(absolute, depth + 1);
          continue;
        }
        if (!entry.isFile()) continue;
        let handle: fs.FileHandle | undefined;
        try {
          const safePath = await resolveFileInsideProject(projectRoot, relative);
          handle = await fs.open(safePath, 'r');
          const stat = await handle.stat();
          if (!stat.isFile()) continue;
          if (stat.size > MAX_FILE_BYTES) {
            skipped.oversized++;
            continue;
          }
          if (bytesRead + stat.size > MAX_BYTES) {
            reasons.add('bytes');
            break;
          }
          const buffer = Buffer.alloc(Math.min(stat.size + 1, MAX_FILE_BYTES + 1));
          let length = 0;
          while (length < buffer.length) {
            const result = await handle.read(buffer, length, buffer.length - length, length);
            if (!result.bytesRead) break;
            length += result.bytesRead;
          }
          bytesRead += length;
          scannedFiles++;
          if (length > MAX_FILE_BYTES) {
            skipped.oversized++;
            continue;
          }
          if (length > stat.size) {
            skipped.unreadable++;
            continue;
          }
          const data = buffer.subarray(0, length);
          if (data.includes(0)) {
            skipped.binary++;
            continue;
          }
          let content: string;
          try {
            content = new TextDecoder('utf-8', { fatal: true }).decode(data);
          } catch {
            skipped.binary++;
            continue;
          }
          const lines = content.split(/\r?\n/);
          for (let index = 0; index < lines.length; index++) {
            if (performance.now() - started >= MAX_MS) {
              reasons.add('time');
              break;
            }
            if (hits.length >= limit) {
              reasons.add('matches');
              break;
            }
            const line = lines[index]!;
            const column = (matchCase ? line : foldCaseSameLength(line)).indexOf(needle);
            if (column < 0) continue;
            const start = Math.max(0, column - 100);
            const end = Math.min(line.length, Math.max(column + queryLength + 100, start + 300));
            hits.push({
              path: relative,
              line: index + 1,
              column: column + 1,
              preview: `${start ? '…' : ''}${line.slice(start, Math.min(end, start + 500))}${end < line.length ? '…' : ''}`,
            });
          }
        } catch {
          skipped.unreadable++;
        } finally {
          await handle?.close();
        }
      }
    }
    await walk(root, 0);
    reply({
      query,
      scope,
      hits,
      scannedFiles,
      visitedEntries,
      bytesRead,
      skipped,
      partial:
        reasons.size > 0 || skipped.depth > 0 || skipped.unreadable > 0 || skipped.oversized > 0,
      reasons: [...reasons],
      limits: {
        matches: limit,
        files: MAX_FILES,
        entries: MAX_ENTRIES,
        bytes: MAX_BYTES,
        fileBytes: MAX_FILE_BYTES,
        milliseconds: MAX_MS,
      },
    });
  } catch (error) {
    reply({ error: errMessage(error), hits: [] });
  }
}
