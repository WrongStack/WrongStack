/**
 * Python source symbol extraction using the `ast` module.
 *
 * Runs the extraction program from `toolchain-scripts.ts` under the resolved
 * interpreter, with the source on stdin, and decodes its JSON.
 *
 * Extracts: class, function, method, property, const, var, type
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { resolveWin32Command } from '@wrongstack/primitives';
import { parseGeneric } from './generic-parser.js';
import { parseParserOutput, toIndexSymbols } from './parser-output.js';
import type { FileSymbols, SymbolLang } from './schema.js';
import { withSpawnGate } from './spawn-gate.js';
import {
  PY_PARSE_SCRIPT,
  privateScriptPath,
  pySpawnOptions,
  runToolchainChild,
} from './toolchain-scripts.js';

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Prefer Python's `ast` when a runtime is available. When Python is missing
 * or the spawn fails, fall back to the generic regex extractor so `.py` files
 * still enter the index instead of being silently empty.
 *
 * Syntax errors from a working Python still return zero symbols (ast cannot
 * recover) — that is intentional correctness, not a gap in coverage.
 */
export async function parseSymbols(opts: {
  file: string;
  content: string;
  lang: SymbolLang;
}): Promise<FileSymbols> {
  const { file, content, lang } = opts;

  try {
    // Serialize python child processes process-wide.
    const native = await withSpawnGate(() => syncPyParse(file, content, lang));
    if (native !== null) return native;
  } catch {
    /* fall through to generic */
  }
  return parseGeneric({ file, content, lang: lang === 'py' ? 'py' : lang });
}

export { detectLang } from './languages.js';

// ─── Interpreter resolution ─────────────────────────────────────────────────

/**
 * Cross-platform Python binary resolver.
 *
 * Windows: walks PATHEXT via `resolveWin32Command` (handles .exe/.cmd/.bat).
 * macOS / Linux: `resolveWin32Command` is a pass-through.
 * Every candidate is verified with `--version`, cached for the process lifetime.
 *
 * Candidates in priority order:
 *   Windows:  python3 → python → py (Python launcher)
 *   Unix:     python3 → python
 */
async function resolvePython(): Promise<string | null> {
  const candidates =
    process.platform === 'win32' ? ['python3', 'python', 'py'] : ['python3', 'python'];
  for (const name of candidates) {
    const resolved = resolveWin32Command(name);
    // On Windows: verify even if resolveWin32Command found a file — the
    // WindowsApps redirector stub (python3.exe) passes the accessSync check
    // but exits with code 9009 (app not found).
    if (!(await commandIsAvailable(resolved))) continue;
    return resolved;
  }
  return null;
}

function commandIsAvailable(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (available: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(available);
    };
    let proc: ChildProcess;
    let timer: NodeJS.Timeout | undefined;
    try {
      proc = spawn(command, ['--version'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
      // uv_spawn can throw SYNCHRONOUSLY on Windows — observed (2026-10-20)
      // as `EPERM ... uv_spawn ...WindowsApps\python3.exe` from the Store App
      // Execution Alias stub. In that case the 'error' event below never
      // fires and an uncaught throw here would reject resolvePythonBinary
      // instead of falling through to the next candidate (and eventually the
      // no-python generic parser). Treat as unavailable.
      finish(false);
      return;
    }
    timer = setTimeout(() => {
      proc.kill('SIGKILL');
      finish(false);
    }, 5_000);
    timer.unref?.();
    proc.once('error', () => finish(false));
    proc.once('close', (code) => finish(code === 0));
  });
}

let cachedPyBinary: Promise<string | null> | undefined;

/**
 * The resolved Python binary (or null when no runtime is available).
 * Shared with the batch parser so both paths run the same interpreter.
 */
export function resolvePythonBinary(): Promise<string | null> {
  cachedPyBinary ??= resolvePython();
  return cachedPyBinary;
}

// ─── Native parse ────────────────────────────────────────────────────────────

/**
 * Run the real Python AST parser.
 * - `null` → Python unavailable / spawn failed / timed out → generic fallback
 * - `FileSymbols` → Python ran (even if the file was invalid → empty symbols)
 */
async function syncPyParse(
  filePath: string,
  content: string,
  lang: SymbolLang,
): Promise<FileSymbols | null> {
  try {
    // A real script file rather than `python -c`: a multi-line program passed
    // on the command line breaks under cmd.exe on Windows.
    const scriptPath = await privateScriptPath('ws-py-parse-', 'parse.py', PY_PARSE_SCRIPT);
    const pyBinary = await resolvePythonBinary();
    if (!pyBinary) return null;

    // argv-array form: no shell, so a hostile filename cannot inject commands.
    const result = await runToolchainChild(
      pyBinary,
      [scriptPath, filePath],
      content,
      15_000,
      pySpawnOptions(scriptPath),
    );
    if (!result) return null;

    if (result.code !== 0 || !result.stdout.trim()) {
      // Python ran but the script failed — empty, not fallback.
      return { file: filePath, lang, symbols: [], mtimeMs: Date.now() };
    }

    const { symbols, refs } = parseParserOutput(result.stdout, lang);
    return {
      file: filePath,
      lang,
      symbols: toIndexSymbols(symbols, filePath, lang),
      refs,
      mtimeMs: Date.now(),
    };
  } catch {
    // Script write / IO failure → generic fallback.
    return null;
  }
}
