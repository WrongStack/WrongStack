import { createHash } from 'node:crypto';
import { open, realpath, stat } from 'node:fs/promises';
import * as path from 'node:path';
import type { Sage } from '../types.js';

export interface MemoryEvidenceSnapshot {
  fingerprint: string;
  files: Array<{ path: string; hash: string; text: string }>;
  unavailable: string[];
  changedAnchor: boolean;
  validityChecks?:
    | Array<{ path: string; text: string; status: 'satisfied' | 'not_satisfied' | 'unknown' }>
    | undefined;
}

/** Bounded, project-contained source evidence. Never follows links outside the project. */
export async function snapshotMemoryEvidence(
  root: string,
  memory: Sage,
): Promise<MemoryEvidenceSnapshot> {
  const canonicalRoot = await realpath(root);
  const paths = [
    ...new Set(
      [
        ...(memory.validity?.checks ?? []).map((c) => c.path),
        ...memory.anchors.map((a) => a.path),
        ...memory.sources.map((s) => s.path),
      ].filter((p): p is string => Boolean(p)),
    ),
  ].slice(0, 4);
  const files: MemoryEvidenceSnapshot['files'] = [];
  const unavailable: string[] = [];
  let changedAnchor = false;
  const validityChecks = memory.validity?.checks?.map((check) => ({
    path: check.path,
    text: check.text,
    status: 'unknown' as 'satisfied' | 'not_satisfied' | 'unknown',
  }));
  for (const sourcePath of paths) {
    try {
      const canonical = await realpath(path.resolve(canonicalRoot, sourcePath));
      const relative = path.relative(canonicalRoot, canonical);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
        throw new Error('outside project');
      const info = await stat(canonical);
      if (!info.isFile() || info.size > 64 * 1024)
        throw new Error('source unavailable or too large');
      const handle = await open(canonical, 'r');
      let data: Buffer;
      try {
        const opened = await handle.stat();
        if (
          !opened.isFile() ||
          opened.ino !== info.ino ||
          opened.dev !== info.dev ||
          (await realpath(canonical)) !== canonical
        )
          throw new Error('source changed while opening');
        // Do not allocate the whole file if another writer grows it after stat.
        const buffer = Buffer.alloc(64 * 1024 + 1);
        let length = 0;
        while (length < buffer.length) {
          const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
          if (bytesRead === 0) break;
          length += bytesRead;
        }
        if (length > 64 * 1024) throw new Error('source grew');
        data = buffer.subarray(0, length);
      } finally {
        await handle.close();
      }
      // Match SAGE anchor verification's persisted hash vocabulary exactly.
      const hash = `sha256:${createHash('sha256').update(data).digest('hex')}`;
      const fullText = data.toString('utf8');
      const normalizedFullText = fullText.includes('\r\n')
        ? fullText.replaceAll('\r\n', '\n')
        : fullText;
      for (const check of validityChecks ?? []) {
        if (check.path === sourcePath) {
          const checkNorm = check.text.includes('\r\n')
            ? check.text.replaceAll('\r\n', '\n')
            : check.text;
          check.status =
            fullText.includes(check.text) || normalizedFullText.includes(checkNorm)
              ? 'satisfied'
              : 'not_satisfied';
        }
      }
      files.push({ path: sourcePath, hash, text: capText(fullText, 6000) });
      if (
        memory.anchors.some((a) => a.path === sourcePath && a.contentHash && a.contentHash !== hash)
      )
        changedAnchor = true;
    } catch {
      unavailable.push(sourcePath);
    }
  }
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ files: files.map(({ path, hash }) => ({ path, hash })), unavailable }))
    .digest('hex');
  return {
    fingerprint,
    files,
    unavailable,
    changedAnchor,
    ...(validityChecks ? { validityChecks } : {}),
  };
}

/**
 * Surrogate-safe truncation — the repo-wide convention for model-bound text.
 * The snapshot's file excerpts feed the memory-companion subagent prompt and
 * the verdict quote corpus; an orphaned surrogate half at the cut would reach
 * the model request ill-formed. The straddling character is dropped whole and
 * the result stays within `max`.
 */
function capText(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const lastKept = text.charCodeAt(end - 1);
  if (lastKept >= 0xd800 && lastKept <= 0xdbff) end -= 1;
  return text.slice(0, end);
}
