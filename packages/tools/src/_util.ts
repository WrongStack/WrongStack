import { createHash } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { activeLimits, positiveLimit, TOOL_MEMORY_GUARD_BYTES } from '@wrongstack/contracts/types';
import type { Context } from '@wrongstack/core/agent';
import * as Core from '@wrongstack/core/utils';
import { type DietResult, dietCommandOutput } from './_output-diet.js';

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
    // Stop when the parent would step outside `stopAt` (or the fs root). A
    // legal in-root directory named `..dot` must not read as an escape here.
    if (
      parent === dir ||
      relParent === '..' ||
      relParent.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relParent)
    ) {
      break;
    }
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
    // Canonical escape test: `..hidden` is a legal in-root first segment, so a
    // bare startsWith('..') would wrongly reject it (same predicate as
    // paths.ts escapesRoot / design.ts guards).
    return (
      rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
    );
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

const pathLocks = new Map<string, Promise<void>>();

/**
 * Run `fn` alone for `absPath` within this process. Read-modify-write file
 * tools serialize on it: several agents share one process, and two of them
 * interleaving read and write on one file would lose an edit.
 */
export async function withPathLock<T>(absPath: string, fn: () => Promise<T>): Promise<T> {
  const key = process.platform === 'win32' ? absPath.toLowerCase() : absPath;
  const previous = pathLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => held);
  pathLocks.set(key, tail);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (pathLocks.get(key) === tail) pathLocks.delete(key);
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

/**
 * Truncate to `max` UTF-8 bytes keeping BOTH ends, appending a marker that
 * reports the true omitted byte count. Like `truncateHeadTail` and
 * `truncateDiffPayload`, marker room is reserved from the budget and both
 * slices are cut byte-accurately (not by UTF-16 code unit), so the result
 * never exceeds `max` — the contract `fetchTool`'s `maxOutputBytes` relies on.
 */
export function truncateMiddle(s: string, max: number): string {
  const total = Buffer.byteLength(s, 'utf8');
  if (total <= max) return s;
  // Reserve a fixed allowance for the marker so the final string can't exceed
  // the cap even though the dropped-byte count's digit width varies.
  const MARKER_RESERVE = 64;
  const avail = Math.max(0, max - MARKER_RESERVE);
  if (avail === 0) return takeHeadBytes(s, max); // budget too small for a marker — hard cut
  const head = takeHeadBytes(s, Math.floor(avail / 2));
  const tail = takeTailBytes(s, avail - Buffer.byteLength(head, 'utf8'));
  const kept = Buffer.byteLength(head, 'utf8') + Buffer.byteLength(tail, 'utf8');
  return `${head}\n…[truncated ${total - kept} bytes from middle]…\n${tail}`;
}

/**
 * Cut `text` to at most `maxBytes` bytes, keeping its head and appending
 * `notice` after a blank line to say what was cut. Like `truncateMiddle` and
 * `truncateDiffPayload`, the notice's room is reserved from the budget and the
 * cut lands on a code-point boundary (`takeHeadBytes`), so the result never
 * exceeds `maxBytes` and never splits a character into U+FFFD. `text` is
 * returned unchanged when it already fits; when the budget cannot hold the
 * notice at all, the text is hard-cut rather than allowed to overrun.
 */
export function capBytesWithNotice(text: string, maxBytes: number, notice: string): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const separator = '\n\n';
  const reserved = Buffer.byteLength(`${separator}${notice}`, 'utf8');
  const head = takeHeadBytes(text, Math.max(0, maxBytes - reserved));
  if (!head) return takeHeadBytes(text, maxBytes);
  return `${head}${separator}${notice}`;
}

export function isBinaryBuffer(buf: Buffer): boolean {
  const len = Math.min(buf.length, 8192);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * True when the whole buffer is well-formed UTF-8. A legacy single-byte text
 * file (Latin-1, Windows-1254) has no NUL, so `isBinaryBuffer` passes it — but
 * a tool that rewrites it from a utf8 decode turns every non-ASCII byte into
 * U+FFFD, far outside the requested change.
 */
export function isValidUtf8(buf: Buffer): boolean {
  try {
    strictUtf8.decode(buf);
    return true;
  } catch {
    return false;
  }
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

/**
 * The inline preview size for command output right now: the user's
 * `limits.toolOutputPreviewBytes` when set, else {@link COMMAND_OUTPUT_MAX_BYTES}.
 * Never a loss — output past it is spooled whole to disk.
 */
export function commandOutputPreviewBytes(): number {
  return positiveLimit(activeLimits().toolOutputPreviewBytes) ?? COMMAND_OUTPUT_MAX_BYTES;
}

/**
 * RAM guard for a command whose output is PARSED (JSON, log lines) rather than
 * shown raw. Not a context budget: the parser needs the whole text, and the
 * structured result reaches the model through the executor's lossless spool.
 * A fixed 100k/200k cut here broke JSON for big monorepos and dropped the
 * newest log lines.
 */
export const PARSED_COMMAND_OUTPUT_GUARD_BYTES = TOOL_MEMORY_GUARD_BYTES;

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
  return truncateHeadTail(cleanCommandOutput(raw), opts.maxBytes ?? commandOutputPreviewBytes());
}

/** Every step of {@link normalizeCommandOutput} but the final cut. */
function cleanCommandOutput(raw: string): string {
  let text = Core.stripAnsi(raw);
  text = collapseCarriageReturns(text);
  text = text.replace(/[ \t]+$/gm, ''); // trailing whitespace per line
  text = collapseConsecutiveDuplicates(text);
  return text.replace(/\n{3,}/g, '\n\n'); // >=2 blank lines → 1
}

/**
 * {@link normalizeCommandOutput} plus the command-aware diet
 * (`_output-diet.ts`), applied BEFORE the head+tail cut so a dieted test run
 * keeps more of its failures within the cap. `diet` is non-null when lines
 * were left out: the caller must persist the full output and append
 * {@link dietNote}.
 */
export function shapeCommandOutput(
  raw: string,
  command: string,
  opts: { maxBytes?: number | undefined } = {},
): { text: string; diet: DietResult | null } {
  if (!raw) return { text: raw, diet: null };
  const clean = cleanCommandOutput(raw);
  const diet = dietCommandOutput(command, clean);
  const maxBytes = opts.maxBytes ?? commandOutputPreviewBytes();
  return { text: truncateHeadTail(diet ? diet.text : clean, maxBytes), diet };
}

/**
 * Collects a command's output for the model: the first `maxChars` and a
 * rolling window of the last `maxChars`. A shell tool used to keep only the
 * head, so a test run or a build that printed more than the preview cap lost
 * exactly the part a reader runs it for — the summary and the failures land
 * last. The dropped middle is still in the output spool.
 */
export interface CommandOutputCapture {
  push(text: string): void;
  /** Head, an omission marker when the middle was dropped, and the tail. */
  text(): string;
}

export function createCommandOutputCapture(maxChars: number): CommandOutputCapture {
  let head = '';
  let tail = '';
  let omitted = 0;
  return {
    push(text) {
      if (!text) return;
      let rest = text;
      if (head.length < maxChars) {
        const take = rest.slice(0, maxChars - head.length);
        head += take;
        rest = rest.slice(take.length);
      }
      if (!rest) return;
      tail += rest;
      // Trim in batches, not per chunk, so a stream of small chunks does not
      // re-slice a maxChars string on every write.
      if (tail.length > maxChars * 2) {
        const cut = tail.length - maxChars;
        omitted += cut;
        tail = tail.slice(cut);
      }
    },
    text() {
      if (tail.length > maxChars) {
        omitted += tail.length - maxChars;
        tail = tail.slice(tail.length - maxChars);
      }
      if (omitted === 0) return head + tail;
      // Start the tail on a whole line: a half line reads as garbage.
      const nl = tail.indexOf('\n');
      const cleanTail = nl >= 0 && nl < 512 ? tail.slice(nl + 1) : tail;
      const dropped = omitted + (tail.length - cleanTail.length);
      return `${head}\n…[${dropped} chars omitted from the middle]…\n${cleanTail}`;
    },
  };
}

/**
 * Build a project-root-relative path shortener for search tool output.
 *
 * `grep` and `glob` emit one path per match, and the absolute project prefix
 * (`D:\long\path\to\project\`) is repeated on every single line — pure token
 * waste in the model's context, since the agent already works from the project
 * root. Stripping it makes match lines read like the paths the user and the
 * other tools use (`packages/tools/src/grep.ts:42:…`).
 *
 * Only paths that actually live under `root` are shortened. The search tools
 * resolve their base through `safeResolveReal`, which also admits
 * `~/.wrongstack`; turning those into a `../../..` chain would be strictly
 * worse than the absolute path, so they are returned untouched. Windows path
 * comparison is case-insensitive (a drive letter can arrive as `d:\` from one
 * source and `D:\` from another) but the returned suffix always preserves the
 * original casing.
 */
export function makeRootRelativizer(root: string): (absPath: string) => string {
  const resolved = path.resolve(root);
  const prefix = resolved.endsWith(path.sep) ? resolved : resolved + path.sep;
  const compare = process.platform === 'win32' ? prefix.toLowerCase() : prefix;
  return (absPath: string): string => {
    const normalizedAbs = process.platform === 'win32' ? absPath.replace(/\//g, '\\') : absPath;
    if (normalizedAbs.length <= prefix.length) return absPath;
    const head =
      process.platform === 'win32'
        ? normalizedAbs.slice(0, prefix.length).toLowerCase()
        : normalizedAbs.slice(0, prefix.length);
    if (head !== compare) return absPath;
    const rest = absPath.slice(prefix.length);
    return rest.length > 0 ? rest : absPath;
  };
}
