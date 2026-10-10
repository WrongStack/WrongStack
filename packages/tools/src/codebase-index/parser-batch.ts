/**
 * Batch parsers for the external toolchain languages (Go, Python) — P3.8.
 *
 * The single-file parsers spawn one `go run` / `python` child process per
 * file. For a 400-file Go project that is 400 process spawns, each paying
 * toolchain startup; the spawn gate serializes them, so parse time scales
 * linearly with spawn cost. This module runs the SAME extraction core (see
 * `toolchain-scripts.ts`) over a batch: one child process per chunk of files,
 * sources in over stdin as a JSON array, one JSON envelope out per file.
 *
 * Fallback contract: a file the batch could not parse (per-file error in the
 * envelope, or the chunk itself failing) is simply ABSENT from the returned
 * map — the caller re-parses those files through the single-file parser,
 * which owns the per-language fallback semantics (Go: regex extractor;
 * Python: generic regex only when the runtime is missing).
 */

import { resolveWin32Command } from '../_win32-resolve.js';
import { parseParserBatchOutput, toIndexSymbols } from './parser-output.js';
import type { FileSymbols, SymbolLang } from './schema.js';
import { withSpawnGate } from './spawn-gate.js';
import {
  GO_BATCH_SCRIPT,
  goSpawnOptions,
  PY_BATCH_SCRIPT,
  privateScriptPath,
  pySpawnOptions,
  runToolchainChild,
} from './toolchain-scripts.js';

/** Max files per child process. Bounded so one pathological file cannot
 *  poison an unbounded chunk and stdin stays a comfortable pipe size. */
const MAX_BATCH_FILES = 100;
/** Max cumulative source bytes per child process. */
const MAX_BATCH_BYTES = 8 * 1024 * 1024;

export interface BatchFile {
  file: string;
  content: string;
  lang: SymbolLang;
}

/** Split a file list into chunks bounded by both file count and total bytes.
 *  Generic so callers' extra per-file fields (e.g. source index) survive. */
export function chunkBatchFiles<T extends BatchFile>(files: readonly T[]): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];
  let bytes = 0;
  for (const file of files) {
    const size = Buffer.byteLength(file.content, 'utf8');
    if (
      current.length > 0 &&
      (current.length >= MAX_BATCH_FILES || bytes + size > MAX_BATCH_BYTES)
    ) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(file);
    bytes += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** Timeout for one chunk: base plus per-file allowance, capped. */
function batchTimeoutMs(fileCount: number): number {
  return Math.min(120_000, 15_000 + fileCount * 1_500);
}

function batchPayload(files: readonly BatchFile[]): string {
  return JSON.stringify(files.map((f) => ({ file: f.file, content: f.content })));
}

function collectBatch(stdout: string, lang: 'go' | 'py'): Map<string, FileSymbols> {
  const out = new Map<string, FileSymbols>();
  for (const entry of parseParserBatchOutput(stdout, lang)) {
    if (entry.error !== undefined) continue;
    out.set(entry.file, {
      file: entry.file,
      lang,
      symbols: toIndexSymbols(entry.symbols, entry.file, lang),
      refs: entry.refs,
      mtimeMs: Date.now(),
    });
  }
  return out;
}

/**
 * Parse a chunk of Go files with ONE `go run` invocation.
 * Returns per-file results; files absent from the map failed and the caller
 * falls back to the single-file parser.
 */
export async function runGoBatch(
  files: readonly BatchFile[],
  goBinary?: string,
): Promise<Map<string, FileSymbols>> {
  if (files.length === 0) return new Map();

  const scriptPath = await privateScriptPath('ws-go-parse-', 'batch.go', GO_BATCH_SCRIPT);

  const result = await withSpawnGate(() =>
    runToolchainChild(
      goBinary ?? resolveWin32Command('go'),
      ['run', scriptPath],
      batchPayload(files),
      batchTimeoutMs(files.length),
      goSpawnOptions(scriptPath),
    ),
  );
  if (result?.code !== 0 || !result.stdout.trim()) return new Map();
  return collectBatch(result.stdout, 'go');
}

/**
 * Parse a chunk of Python files with ONE interpreter invocation.
 * Same contract as {@link runGoBatch}; `pythonBinary` is the cached resolver
 * from py-parser.ts so both paths agree on which interpreter runs.
 */
export async function runPyBatch(
  files: readonly BatchFile[],
  pythonBinary: string,
): Promise<Map<string, FileSymbols>> {
  if (files.length === 0) return new Map();

  const scriptPath = await privateScriptPath('ws-py-parse-', 'batch.py', PY_BATCH_SCRIPT);

  const result = await withSpawnGate(() =>
    runToolchainChild(
      pythonBinary,
      [scriptPath],
      batchPayload(files),
      batchTimeoutMs(files.length),
      pySpawnOptions(scriptPath),
    ),
  );
  if (result?.code !== 0 || !result.stdout.trim()) return new Map();
  return collectBatch(result.stdout, 'py');
}
