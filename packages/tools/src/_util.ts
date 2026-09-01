import { createHash } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { Context } from '@wrongstack/core/agent';
import * as Core from '@wrongstack/core/utils';

/**
 * sha-256 hex of a UTF-8 string. Used by the file tools to record a content
 * hash alongside the mtime in `ctx.recordRead` — the hash is the authoritative
 * staleness arbiter for `edit` (mtime has a 2 s tolerance window on Windows).
 */
export function sha256hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}
/** Detected package manager for a project directory. */
export type PackageManager = 'pnpm' | 'yarn' | 'npm';

/**
 * Detect the project's package manager.
 *
 * Per directory, precedence is: `package.json#packageManager` (authoritative
 * when declared) → `pnpm-lock.yaml` → `yarn.lock` → `bun.lockb`/`bun.lock`
 * (bun is treated as npm-compatible and reported as `npm`) →
 * `package-lock.json`/`npm-shrinkwrap.json`. When `stopAt` (usually the
 * project root) is provided and `cwd` is nested inside it, parent directories
 * are walked up to and including `stopAt` — monorepo packages rarely carry
 * their own lockfile. Missing or unreadable directories fall back to `npm`
 * rather than throwing, so a `safeResolve`-checked cwd that happens to be
 * empty never aborts the tool.
 */
export async function detectPackageManager(cwd: string, stopAt?: string): Promise<PackageManager> {
  let dir = path.resolve(cwd);
  const stop = stopAt ? path.resolve(stopAt) : dir;
  for (;;) {
    const found = await detectPackageManagerInDir(dir);
    if (found) return found;
    if (dir === stop) break;
    const parent = path.dirname(dir);
    const relParent = path.relative(stop, parent);
    // Stop when the parent would step outside `stopAt` (or the fs root).
    if (parent === dir || relParent.startsWith('..') || path.isAbsolute(relParent)) break;
    dir = parent;
  }
  return 'npm';
}

/** One-directory probe for {@link detectPackageManager}; null = keep walking. */
async function detectPackageManagerInDir(dir: string): Promise<PackageManager | null> {
  const fs = await import('node:fs/promises');
  // 1. Honor an explicit `package.json#packageManager` declaration.
  try {
    const raw = await fs.readFile(path.join(dir, 'package.json'), 'utf8');
    const declared = (JSON.parse(raw) as { packageManager?: unknown }).packageManager;
    if (typeof declared === 'string') {
      const name = declared.split('@')[0] ?? '';
      if (name === 'pnpm' || name === 'yarn') return name;
      // bun has no first-class branch in the callers; treat as npm-compatible.
      if (name === 'npm' || name === 'bun') return 'npm';
    }
  } catch {
    /* missing / unparseable package.json — fall through to lockfiles */
  }
  // 2. Lockfiles.
  const lockfiles: Array<[string, PackageManager]> = [
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lockb', 'npm'],
    ['bun.lock', 'npm'],
    ['package-lock.json', 'npm'],
    ['npm-shrinkwrap.json', 'npm'],
  ];
  for (const [file, manager] of lockfiles) {
    try {
      await fs.stat(`${dir}/${file}`);
      return manager;
    } catch {
      /* not this one */
    }
  }
  return null;
}

export function resolvePath(input: string, ctx: Context): string {
  return path.isAbsolute(input)
    ? path.normalize(input)
    : path.resolve(ctx.workingDir ?? ctx.cwd, input);
}

/**
 * Roots every file tool may always reach, even in restricted mode: the
 * project root and the user-global `~/.wrongstack` directory (config, memory,
 * sessions, skills). `~/.wrongstack` honors the `WRONGSTACK_HOME` override.
 */
function allowedRoots(ctx: Context): string[] {
  return [path.resolve(ctx.projectRoot), path.resolve(Core.wstackGlobalRoot())];
}

/** True if `target` is `root` itself or nested inside any of `roots`. */
function isInsideAny(target: string, roots: string[]): boolean {
  return roots.some((root) => {
    const rel = path.relative(root, target);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });
}

export function ensureInsideRoot(absPath: string, ctx: Context): string {
  const target = path.resolve(absPath);
  // Unrestricted filesystem access: skip the project-root containment check.
  if (ctx.allowOutsideProjectRoot) return target;
  if (isInsideAny(target, allowedRoots(ctx))) return target;
  throw new Error(`Path "${absPath}" is outside project root "${path.resolve(ctx.projectRoot)}"`);
}

export function safeResolve(input: string, ctx: Context): string {
  return ensureInsideRoot(resolvePath(input, ctx), ctx);
}

/**
 * Defense against in-root→out-of-root symlink escape (CWE-59). `safeResolve`
 * only does a syntactic `../` check, so a symlink that lives *inside* the
 * project root but points outside still passes it. This resolves the path
 * through `fs.realpath` and re-verifies containment against the realpath of
 * the project root (comparing like-for-like, since the root itself may be a
 * symlink — macOS `/var`→`/private/var`, Windows 8.3 short names). For a path
 * that does not exist yet (e.g. a `write` to a new file) the nearest existing
 * ancestor directory is checked instead. Throws if the real target escapes.
 *
 * Mirrors the per-file guard already used in `replace.ts`/`grep.ts`; applied
 * to single-file `read`/`edit`/`write` it throws (rather than skips) because
 * the caller named exactly one file.
 */
export async function assertRealInsideRoot(absPath: string, ctx: Context): Promise<void> {
  await resolveRealInsideRoot(absPath, ctx);
}

/**
 * Containment check that RETURNS the canonical path it validated (WS-048).
 *
 * The check resolves symlinks and then confirms the resolved target is inside
 * an allowed root. Handing the caller back the *unresolved* path throws that
 * work away: the caller opens a path whose components are still symlinks, so
 * whatever the check proved about the target is no longer what the caller
 * touches. Swapping an intermediate component between the check and the open
 * redirects the operation, and nothing downstream re-validates.
 *
 * Returning the resolved path removes that gap for every component that
 * existed at check time — those are now literal directories, not links that can
 * be re-pointed. It is not a total TOCTOU cure (only fd-relative operations
 * would be), but the window it closes is the one this function's own contract
 * claims to have closed.
 *
 * For a path that does not exist yet — a `write` to a new file — the deepest
 * existing ancestor is resolved and the not-yet-created tail is re-joined onto
 * it, so the canonical form is still returned rather than the raw input.
 */
export async function resolveRealInsideRoot(absPath: string, ctx: Context): Promise<string> {
  // Unrestricted filesystem access: no symlink-escape check to perform.
  if (ctx.allowOutsideProjectRoot) return absPath;
  // Compare like-for-like against the realpath of each always-allowed root
  // (project root + ~/.wrongstack), since a root may itself be a symlink.
  const realRoots = await Promise.all(
    allowedRoots(ctx).map((r) => fsp.realpath(r).catch(() => path.resolve(r))),
  );
  let probe = absPath;
  // Segments stripped while walking up to an existing ancestor, so the
  // not-yet-created tail can be re-attached to the resolved prefix.
  const pendingTail: string[] = [];
  for (;;) {
    let real: string;
    try {
      real = await fsp.realpath(probe);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        const parent = path.dirname(probe);
        if (parent === probe) return absPath; // reached fs root without escaping
        pendingTail.unshift(path.basename(probe));
        probe = parent;
        continue;
      }
      throw err;
    }
    // Containment is decided on the REASSEMBLED path, not on the bare existing
    // ancestor. Walking up past a root that does not exist yet (a fresh
    // project dir, or a caller whose `projectRoot` is not on disk) lands on a
    // real ancestor that is legitimately outside it — `D:\` while the root is
    // `D:\project` — and comparing that ancestor alone rejected the very path
    // the caller asked for. Re-attaching the tail cannot traverse a symlink,
    // because those segments do not exist, and `pendingTail` is built from
    // `path.basename` of an already-resolved absolute path, so it can never
    // contain `..`.
    const candidate = pendingTail.length > 0 ? path.join(real, ...pendingTail) : real;
    if (isInsideAny(candidate, realRoots)) {
      return candidate;
    }
    throw new Error(
      `Path "${absPath}" resolves through a symlink outside project root "${realRoots[0]}"`,
    );
  }
}

/**
 * `safeResolve` + symlink realpath containment check, returning the CANONICAL
 * path (WS-048).
 *
 * This used to return the unvalidated `abs` while validating `real`, so the
 * header's promise of a "containment check" did not extend to the value the
 * caller then opened.
 */
export async function safeResolveReal(input: string, ctx: Context): Promise<string> {
  const abs = safeResolve(input, ctx);
  return await resolveRealInsideRoot(abs, ctx);
}

/**
 * Project-root-relative variant of {@link safeResolveReal} for the codebase
 * tools whose documented input contract is "relative to projectRoot or
 * absolute" (codebase-skeleton, security-ast-scan, codebase-invariant-check,
 * codebase-ast-replace). The sibling file tools (edit/grep/glob/…) resolve
 * relative input against the session cwd — that is THEIR contract; these four
 * always resolved against the project root and their schemas say so. Routing
 * them through plain safeResolveReal silently changed that: with a nested
 * workingDir (worktrees, set_working_dir) a relative input resolved to the
 * wrong file. Containment is still enforced exactly as in safeResolveReal
 * (realpath + allowOutsideProjectRoot honored).
 */
export async function safeResolveProjectPath(input: string, ctx: Context): Promise<string> {
  const root = ctx.projectRoot ?? ctx.cwd ?? process.cwd();
  const abs = path.isAbsolute(input) ? input : path.resolve(root, input);
  return await safeResolveReal(abs, ctx);
}

/**
 * Truncate a diff (or similar text payload) to `maxBytes`, cutting at a line
 * boundary and appending an explicit marker. Used by the mutating file tools
 * (`write`, `edit`, `replace`) so their returned diffs stay inside the tool's
 * declared `maxOutputBytes` budget instead of relying on downstream clipping.
 */
export function truncateDiffPayload(
  diff: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  const total = Buffer.byteLength(diff, 'utf8');
  if (total <= maxBytes) return { text: diff, truncated: false };
  // Reserve room for the marker so the final string never exceeds the cap.
  const MARKER_RESERVE = 96;
  let head = takeHeadBytes(diff, Math.max(0, maxBytes - MARKER_RESERVE));
  const nl = head.lastIndexOf('\n');
  if (nl > 0) head = head.slice(0, nl);
  const kept = Buffer.byteLength(head, 'utf8');
  return {
    text: `${head}\n…[diff truncated: ${total - kept} of ${total} bytes omitted]`,
    truncated: true,
  };
}

export function truncateMiddle(s: string, max: number): string {
  if (Buffer.byteLength(s, 'utf8') <= max) return s;
  const half = Math.floor(max / 2);
  return (
    s.slice(0, half) +
    `\n…[truncated ${Buffer.byteLength(s, 'utf8') - max} bytes from middle]…\n` +
    s.slice(-half)
  );
}

export function isBinaryBuffer(buf: Buffer): boolean {
  const len = Math.min(buf.length, 8192);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

// ─── Command-output normalization (token-saving) ────────────────────────────
//
// Raw process output is full of tokens the model gains nothing from: ANSI
// escapes, carriage-return progress spam, runs of identical warning lines, and
// huge tails of build noise. These helpers strip that noise before the output
// reaches the LLM. They are scoped to COMMAND tools (bash/git/exec and the
// _spawn-stream consumers) — never applied to structured/code outputs.

/** Unified byte cap for all command tool output fed to the model. */
export const COMMAND_OUTPUT_MAX_BYTES = 32_768;

/** Runs of >= this many identical consecutive lines are collapsed. */
const REPEAT_RUN_THRESHOLD = 3;

/**
 * Collapse carriage-return overwrites the way a terminal would: `\r\n` becomes
 * `\n`, and a bare `\r` (progress redraw) keeps only the text after the LAST
 * `\r` on its physical line. Without this, a single progress bar that redraws
 * 200 times explodes into 200 lines.
 */
export function collapseCarriageReturns(text: string): string {
  const lf = text.replace(/\r\n/g, '\n');
  if (!lf.includes('\r')) return lf;
  return lf
    .split('\n')
    .map((line) => (line.includes('\r') ? line.slice(line.lastIndexOf('\r') + 1) : line))
    .join('\n');
}

/**
 * Collapse a run of `minRun`+ identical consecutive lines into the line once
 * plus a marker. Consecutive-only — it never reorders or dedups non-adjacent
 * lines, so diffs/source stay intact.
 */
export function collapseConsecutiveDuplicates(text: string, minRun = REPEAT_RUN_THRESHOLD): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    let j = i + 1;
    while (j < lines.length && lines[j] === lines[i]) j++;
    const run = j - i;
    if (run >= minRun) {
      out.push(lines[i]!, `… ⟨repeated ${run}×⟩`);
    } else {
      for (let k = i; k < j; k++) out.push(lines[k]!);
    }
    i = j;
  }
  return out.join('\n');
}

/** Largest prefix of `s` whose UTF-8 byte length is <= `maxBytes`. */
function takeHeadBytes(s: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  /* v8 ignore next -- only caller (truncateHeadTail) passes a budget smaller than s; defensive. */
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (Buffer.byteLength(s.slice(0, mid), 'utf8') <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return s.slice(0, lo);
}

/** Largest suffix of `s` whose UTF-8 byte length is <= `maxBytes`. */
function takeTailBytes(s: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  /* v8 ignore next -- only caller (truncateHeadTail) passes a budget smaller than s; defensive. */
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (Buffer.byteLength(s.slice(s.length - mid), 'utf8') <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return s.slice(s.length - lo);
}

/**
 * Truncate to `maxBytes` keeping BOTH ends — the head (what ran / early context)
 * and the tail (errors and summaries usually land last), biased ~45/55 toward
 * the tail. The result never exceeds `maxBytes`.
 */
export function truncateHeadTail(s: string, maxBytes: number): string {
  const total = Buffer.byteLength(s, 'utf8');
  if (total <= maxBytes) return s;
  // Reserve a fixed allowance for the marker so the final string can't exceed
  // the cap even though the dropped-byte count's digit width varies.
  const MARKER_RESERVE = 64;
  const avail = Math.max(0, maxBytes - MARKER_RESERVE);
  const headBudget = Math.floor(avail * 0.45);
  const head = takeHeadBytes(s, headBudget);
  const tail = takeTailBytes(s, avail - Buffer.byteLength(head, 'utf8'));
  const kept = Buffer.byteLength(head, 'utf8') + Buffer.byteLength(tail, 'utf8');
  return `${head}\n…[truncated ${total - kept} bytes]…\n${tail}`;
}

/**
 * Full token-saving pipeline for command tool output: strip ANSI → collapse
 * carriage-return progress → trim trailing whitespace → collapse identical
 * consecutive lines → squeeze blank-line runs → head+tail truncate to the cap.
 */
export function normalizeCommandOutput(
  raw: string,
  opts: { maxBytes?: number | undefined } = {},
): string {
  if (!raw) return raw;
  let text = Core.stripAnsi(raw);
  text = collapseCarriageReturns(text);
  text = text.replace(/[ \t]+$/gm, ''); // trailing whitespace per line
  text = collapseConsecutiveDuplicates(text);
  text = text.replace(/\n{3,}/g, '\n\n'); // >=2 blank lines → 1
  return truncateHeadTail(text, opts.maxBytes ?? COMMAND_OUTPUT_MAX_BYTES);
}
