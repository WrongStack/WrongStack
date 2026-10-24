import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { ToolValidationError } from '@wrongstack/contracts/types';
import { compilePathGlob } from '@wrongstack/core/utils';
import { mapWithConcurrency } from './_concurrency.js';
import { expandBraceAlternation } from './_glob-braces.js';
import { capSubject, compileUserRegex } from './_regex.js';
import { isBinaryBuffer } from './_util.js';
import { loadGitignoreMatcher } from './codebase-index/gitignore.js';
import type { GrepInput, GrepOutput } from './grep-types.js';
import { DEFAULT_IGNORE } from './grep-types.js';

const NATIVE_SCAN_CONCURRENCY = 32;

const NATIVE_READ_CHUNK_BYTES = 64 * 1024;

const NATIVE_MAX_FILE_BYTES = 1_000_000;

export async function runNative(
  input: GrepInput,
  base: string,
  mode: 'content' | 'files_with_matches' | 'count',
  limit: number,
  signal: AbortSignal,
  relativize: (absPath: string) => string,
): Promise<GrepOutput> {
  if (signal.aborted) {
    return {
      matches: [],
      count: 0,
      truncated: false,
      used: 'native',
    };
  }

  const flags = input.case_insensitive ? 'i' : '';
  const compiled = compileUserRegex(input.pattern, flags);
  if (!compiled.ok) {
    throw new ToolValidationError({
      message: `grep: ${compiled.reason}`,
      field: 'pattern',
    });
  }
  const re = compiled.regex;
  // `*.{ts,tsx}` alternates (ripgrep expands it); core path globs read braces literally.
  const globs = input.glob
    ? expandBraceAlternation(input.glob).map((g) => compilePathGlob(g))
    : null;
  // rg honors .gitignore natively; give the fallback the same pruning so a
  // project whose artifacts aren't in DEFAULT_IGNORE isn't scanned in full.
  const isGitIgnored = await loadGitignoreMatcher(base);
  const matches: string[] = [];
  const maxBytes = NATIVE_MAX_FILE_BYTES;
  let total = 0;
  let stopped = false;
  let countTruncated = false;

  const scanFile = async (full: string, name: string, rel: string): Promise<void> => {
    if (stopped || signal.aborted) return;
    if (globs) {
      const normRel = rel.replace(/\\/g, '/');
      const normFull = full.replace(/\\/g, '/');
      const matchesGlob = globs.some((globRe) => {
        globRe.lastIndex = 0;
        const hit = globRe.test(name) || globRe.test(normRel) || globRe.test(normFull);
        globRe.lastIndex = 0;
        return hit;
      });
      if (!matchesGlob) return;
    }

    try {
      const stat = await fs.stat(full);
      if (!stat.isFile() || stat.size > maxBytes || stopped || signal.aborted) return;

      const file = await fs.open(full, 'r');
      try {
        let bytesReadTotal = 0;
        let lineNumber = 0;
        let fileHits = 0;
        let leftover = '';
        // Chunk-boundary-safe decoding: a multi-byte character can be split
        // across two reads, so `chunk.toString('utf8')` would decode both
        // halves as U+FFFD. The decoder carries the incomplete sequence into
        // the next chunk.
        const decoder = new StringDecoder('utf8');
        let binaryChecked = false;
        const buffer = Buffer.allocUnsafe(Math.min(NATIVE_READ_CHUNK_BYTES, maxBytes));

        while (!stopped && !signal.aborted && bytesReadTotal < maxBytes) {
          const remaining = maxBytes - bytesReadTotal;
          const { bytesRead } = await file.read(
            buffer,
            0,
            Math.min(buffer.length, remaining),
            null,
          );
          if (bytesRead === 0) break;
          const chunk = buffer.subarray(0, bytesRead);
          if (!binaryChecked) {
            binaryChecked = true;
            if (isBinaryBuffer(chunk)) return;
          }
          bytesReadTotal += bytesRead;
          const text = leftover + decoder.write(chunk);
          const lines = text.split(/\r?\n/);
          leftover = lines.pop() ?? '';

          for (const rawLine of lines) {
            if (stopped || signal.aborted) break;
            lineNumber++;
            const ln = rawLine.length > 4096 ? capSubject(rawLine) : rawLine;
            if (re.global || re.sticky) re.lastIndex = 0;
            if (!re.test(ln)) continue;

            if (mode === 'content') {
              if (matches.length < limit) {
                fileHits++;
                total++;
                matches.push(`${relativize(full)}:${lineNumber}:${ln}`);
              } else {
                stopped = true;
                break;
              }
            } else if (mode === 'files_with_matches') {
              if (matches.length < limit) {
                fileHits++;
                total++;
                matches.push(relativize(full));
              } else {
                stopped = true;
              }
              break;
            } else {
              if (matches.length >= limit) {
                countTruncated = true;
                stopped = true;
                break;
              }
              fileHits++;
              total++;
            }
          }

          if (mode === 'files_with_matches' && fileHits > 0) break;
        }

        // Flush the decoder's tail into the final line before it is tested.
        leftover += decoder.end();

        // files_with_matches already recorded this file on its first hit.
        const fileListed = mode === 'files_with_matches' && fileHits > 0;
        if (!stopped && !signal.aborted && !fileListed && leftover.length > 0) {
          lineNumber++;
          const ln = leftover.length > 4096 ? capSubject(leftover) : leftover;
          if (re.global || re.sticky) re.lastIndex = 0;
          if (re.test(ln)) {
            if (mode === 'content') {
              if (matches.length < limit) {
                fileHits++;
                total++;
                matches.push(`${relativize(full)}:${lineNumber}:${ln}`);
              } else {
                stopped = true;
              }
            } else if (mode === 'files_with_matches') {
              if (matches.length < limit) {
                fileHits++;
                total++;
                matches.push(relativize(full));
              } else {
                stopped = true;
              }
            } else {
              if (matches.length >= limit) {
                countTruncated = true;
                stopped = true;
              } else {
                fileHits++;
                total++;
              }
            }
          }
        }

        if (fileHits > 0 && mode === 'count') {
          if (matches.length < limit) {
            matches.push(`${relativize(full)}:${fileHits}`);
          } else {
            countTruncated = true;
            stopped = true;
          }
        }
      } finally {
        await file.close();
      }
    } catch {
      // skip read errors
    }
  };

  const walk = async (dir: string, relPrefix: string): Promise<void> => {
    if (stopped || signal.aborted) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const files: Array<{ full: string; name: string; rel: string }> = [];
    const subdirs: Array<{ full: string; rel: string }> = [];
    for (const e of entries) {
      if (stopped) return;
      if (DEFAULT_IGNORE.has(e.name)) continue;
      if (e.isSymbolicLink()) continue;
      const rel = relPrefix ? `${relPrefix}/${e.name}` : e.name;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (isGitIgnored(rel, true)) continue;
        subdirs.push({ full, rel });
      } else if (e.isFile()) {
        if (isGitIgnored(rel, false)) continue;
        files.push({ full, name: e.name, rel });
      }
    }
    await mapWithConcurrency(files, NATIVE_SCAN_CONCURRENCY, ({ full, name, rel }) =>
      scanFile(full, name, rel),
    );
    await mapWithConcurrency(subdirs, Math.min(16, NATIVE_SCAN_CONCURRENCY), ({ full, rel }) =>
      walk(full, rel),
    );
  };

  const baseStat = await fs.stat(base).catch(() => null);
  if (baseStat?.isFile()) {
    const rel = input.path ? input.path.replace(/\\/g, '/') : path.basename(base);
    await scanFile(base, path.basename(base), rel);
  } else {
    await walk(base, '');
  }

  return {
    matches,
    count: total,
    truncated: stopped || countTruncated,
    used: 'native',
  };
}
