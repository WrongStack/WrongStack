import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Tool } from '@wrongstack/core/types';
import { buildChildEnv, toErrorMessage } from '@wrongstack/core/utils';
import { resolveRealInsideRoot, safeResolveReal, sha256hex } from './_util.js';
import { enqueueReindex } from './codebase-index/background-indexer.js';

interface PatchInput {
  patch: string;
  directory?: string | undefined;
  strip?: number | undefined;
  dry_run?: boolean | undefined;
}

interface PatchOutput {
  applied: number;
  rejected: number;
  files: string[];
  dry_run: boolean;
  message: string;
}

export const patchTool: Tool<PatchInput, PatchOutput> = {
  name: 'patch',
  category: 'Filesystem',
  description:
    'Apply a unified diff (patch) to the project. This is the correct tool when you have a diff that needs to be applied precisely, including handling of rejects.',
  usageHint:
    'Best used when you already have a diff (from generation, external source, or previous step).\n' +
    '- Use `dry_run: true` to see what would happen without modifying files.\n' +
    '- Applied with `--merge`: a conflicting hunk writes git-style conflict\n' +
    '  markers (<<<<<<< / ======= / >>>>>>>) INTO the file and reports failure.\n' +
    '  It does NOT create .rej/.orig files. `files` lists what changed on disk\n' +
    '  even when the patch failed, so read those back before retrying.\n' +
    'Often cleaner than many small `edit` operations for larger changes.',
  selection: {
    doNotUseWhen: 'you do not already have a unified diff or only need one precise replacement.',
    useInstead: ['edit'],
  },
  permission: 'confirm',
  // WS-046: gives permission decisions something to key on.
  // The target directory. The patch body itself is unstable (every diff
  // differs), so it could never re-match its own stored rule.
  subjectKey: 'directory',
  mutating: true,
  capabilities: ['fs.write'],
  icon: 'edit',
  timeoutMs: 30_000,
  inputSchema: {
    type: 'object',
    properties: {
      patch: { type: 'string', description: 'Unified diff patch content' },
      directory: { type: 'string', description: 'Root directory for patch (default: cwd)' },
      strip: { type: 'integer', description: 'Strip leading path components (default: 1)' },
      dry_run: { type: 'boolean', description: 'Preview without applying' },
    },
    required: ['patch'],
  },
  async execute(input, ctx, opts) {
    if (!input?.patch) throw new Error('patch: patch content is required');

    const signal = opts?.signal ?? ctx.signal ?? new AbortController().signal;
    const strip = Math.max(1, input.strip ?? 1);
    const dryRun = input.dry_run ?? false;
    const refuse = (message: string): PatchOutput => ({
      applied: 0,
      rejected: 1,
      files: [],
      dry_run: dryRun,
      message,
    });

    // `safeResolve` is the SYNTACTIC `../` check only. Every sibling file tool
    // was upgraded to the realpath form (read.ts, write.ts, edit.ts, glob.ts);
    // `patch` was not, so a junction/symlinked `directory` passed the check —
    // `path.relative` saw no `..` — and GNU patch then resolved it in the OS
    // and wrote outside the project root.
    let dir: string;
    try {
      dir = input.directory ? await safeResolveReal(input.directory, ctx) : ctx.cwd;
    } catch (err) {
      return refuse(`patch refused: ${toErrorMessage(err)}`);
    }

    // Compare against the REAL project root: the root may itself be a symlink,
    // and the containment test below has to be like-for-like with the resolved
    // target paths.
    const realRoot = await fs.realpath(ctx.projectRoot).catch(() => path.resolve(ctx.projectRoot));

    // Pre-flight: scan diff target paths and reject any that resolve outside
    // the project root. This catches `../../../etc/passwd`-style escapes
    // before we hand the diff to GNU patch.
    const targets = extractDiffTargets(input.patch);
    const resolvedTargets: DiffTarget[] = [];
    for (const t of targets) {
      const stripped = stripPathComponents(t.raw, strip);
      if (!stripped) continue;
      // Defense-in-depth: GNU patch treats a stripped remainder that is
      // absolute as an absolute path, ignoring `dir`. Our corrected stripper
      // won't produce a leading '/', but reject explicitly so a future edge
      // case (Windows drive letters, UNC paths) can't slip through.
      if (path.isAbsolute(stripped)) {
        return refuse(`patch refused: target "${t.raw}" strips to absolute path`);
      }
      const candidate = path.resolve(dir, stripped);
      let real: string;
      try {
        real = await resolveRealInsideRoot(candidate, ctx);
      } catch (err) {
        return refuse(`patch refused: target "${t.raw}" ${toErrorMessage(err)}`);
      }
      const rel = path.relative(realRoot, real);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        return refuse(`patch refused: target "${t.raw}" resolves outside project root`);
      }
      resolvedTargets.push({ raw: t.raw, deleted: t.deleted, abs: real });
    }

    // Snapshot target contents before applying so the change can be recorded
    // for session rewind and stale-read tracking (same bookkeeping as `edit`).
    // Track existence separately from content: a >5 MB or binary file exists
    // but has null content, while a new-file target (diff says create) does
    // not exist at all. Without this distinction the post-apply bookkeeping
    // cannot tell a real deletion from a no-op on a nonexistent file.
    const beforeContents = new Map<string, string | null>();
    const beforeExisted = new Set<string>();
    if (!dryRun) {
      for (const target of resolvedTargets) {
        const existed = (await fs.stat(target.abs!).catch(() => null))?.isFile() ?? false;
        if (existed) beforeExisted.add(target.abs!);
        beforeContents.set(target.abs!, await readTextForTracking(target.abs!));
      }
    }

    // Write the diff into a private 0700 temp directory rather than into
    // the user-controlled `dir` with a predictable timestamp name. Avoids
    // symlink-bait races on shared work trees.
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), '.wstack_patch_'));
    try {
      await fs.chmod(tmpDir, 0o700).catch(() => {
        /* best-effort on Windows */
      });
      const patchFile = path.join(tmpDir, 'in.diff');
      await fs.writeFile(patchFile, input.patch, { mode: 0o600 });

      const args = [`-p${strip}`, '--merge', ...(dryRun ? ['--dry-run'] : []), '-i', patchFile];

      const result = await runPatch(args, dir, signal, {
        patchFile,
        strip,
        dryRun,
      });

      // Record what actually changed: mtime + hash (tagged 'write' so the
      // permission bypass does not widen) so a later `edit` doesn't trip the
      // stale-read guard on our own write, plus the before/after pair for
      // session rewind.
      //
      // This MUST run before the exit-code branch below. `--merge` does not
      // produce `.rej` files: on a conflicting hunk it writes git-style
      // conflict markers INTO the source file and exits 1. The early return
      // used to sit above this block, so a conflicted (or partially applied)
      // patch left the file modified on disk with no rewind record, no
      // read-tracking update — a later `edit` then threw `external_modification`
      // — and told the model `applied: 0`, i.e. nothing happened.
      const touched: string[] = [];
      if (!dryRun) {
        for (const target of resolvedTargets) {
          const abs = target.abs!;
          const before = beforeContents.get(abs) ?? null;
          const stat = await fs.stat(abs).catch(() => null);
          if (!stat?.isFile()) {
            // Gone. A deletion diff (`+++ /dev/null`) reaches this branch.
            // Only record when the file actually existed before the patch —
            // a target that never existed is a no-op, not a deletion. When the
            // file existed but was > 5 MB or binary (before === null), record
            // anyway so rewind at least knows a deletion happened and can
            // report the gap rather than silently losing the file.
            if (beforeExisted.has(abs)) {
              touched.push(abs);
              ctx.session?.recordFileChange?.({
                path: abs,
                action: 'deleted',
                before,
                after: null,
              });
            }
            continue;
          }
          const after = await readTextForTracking(abs);
          if (after === null || after === before) continue;
          touched.push(abs);
          // Optional calls: embedders may hand in a duck-typed Context.
          ctx.recordRead?.(abs, stat.mtimeMs, 'write', sha256hex(after));
          ctx.session?.recordFileChange?.({
            path: abs,
            action: before === null ? 'created' : 'modified',
            before,
            after,
          });
        }

        if (touched.length > 0) {
          try {
            enqueueReindex({ projectRoot: ctx.projectRoot, files: touched });
          } catch {
            // Non-fatal background reindex
          }
        }
      }

      if (result.exitCode !== 0) {
        if (!dryRun) {
          const partial =
            touched.length > 0
              ? ` ${touched.length} file(s) were still modified on disk and have been recorded for rewind: ${touched
                  .map((p) => path.relative(realRoot, p) || p)
                  .join(', ')}.`
              : '';
          return {
            applied: touched.length,
            rejected: 1,
            // Normalize to relative-to-realRoot for API consistency with the
            // success path (which returns GNU patch's dir-relative names).
            // `touched` entries are realpaths from resolveRealInsideRoot, and
            // realRoot is also a realpath, so path.relative is like-for-like.
            files: touched.map((p) => path.relative(realRoot, p) || p),
            dry_run: dryRun,
            message: `patch failed: ${result.stderr || result.stdout}${partial}`,
          };
        }
        // Dry-run with a non-zero exit: GNU patch --dry-run still exits
        // non-zero when the patch would conflict. Without this branch the code
        // fell through to the success path, reporting rejected: 0 for a patch
        // that would actually fail — a misleading "clean" preview.
        const wouldPatch = extractPatchedFiles(result.stdout);
        return {
          applied: wouldPatch.length,
          rejected: 1,
          files: wouldPatch,
          dry_run: dryRun,
          message: `patch preview: would conflict — ${result.stderr || result.stdout}`,
        };
      }

      const patched =
        result.engine === 'git'
          ? [
              ...new Set(
                resolvedTargets.map((target) => path.relative(dir, target.abs!) || target.abs!),
              ),
            ]
          : extractPatchedFiles(result.stdout);

      return {
        applied: patched.length,
        rejected: 0,
        files: patched,
        dry_run: dryRun,
        message: result.stdout || 'patch applied',
      };
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  },
};

/** Read a target file as UTF-8 for change tracking. Returns null when the
 *  file is missing (new-file diff), binary, or too large to snapshot. */
const MAX_TRACKING_BYTES = 5 * 1024 * 1024;
async function readTextForTracking(absPath: string): Promise<string | null> {
  try {
    const stat = await fs.stat(absPath);
    if (!stat.isFile() || stat.size > MAX_TRACKING_BYTES) return null;
    const buf = await fs.readFile(absPath);
    if (buf.includes(0)) return null; // binary
    return buf.toString('utf8');
  } catch {
    return null;
  }
}

/** A file the diff addresses. `abs` is filled in once containment is checked. */
interface DiffTarget {
  raw: string;
  /** The diff removes this file (`+++ /dev/null`). */
  deleted: boolean;
  abs?: string;
}

/**
 * Extract every file a unified diff addresses.
 *
 * Scanning only `+++` and skipping `/dev/null` silently dropped every
 * DELETION: a removal hunk is `--- a/f` + `+++ /dev/null`, so the target list
 * came back empty, nothing was containment-checked, nothing was snapshotted
 * for rewind — and `applied` was still reported from GNU patch's stdout. An
 * LLM-authored deletion diff destroyed files that session rewind could not
 * bring back. For those the `---` side names the file being removed.
 */
function extractDiffTargets(patch: string): DiffTarget[] {
  const out: DiffTarget[] = [];
  // Cap each name at 4096 chars to prevent maliciously long lines from
  // causing regex backtracking issues in large patches. Strips optional
  // tab-prefixed timestamp suffixes that some diff tools emit.
  const clean = (raw: string | undefined): string => {
    if (!raw) return '';
    return (raw.length > 4096 ? raw.slice(0, 4096) : raw).trim();
  };

  let lastOld: string | undefined;
  // Track hunk state: once inside a @@ hunk body, lines starting with ---
  // or +++ are *content* (removed/added lines), not file headers. A removed
  // content line "-- note" appears in the diff as "--- note", which matched
  // the file-header regex and produced phantom targets.
  let inHunk = false;
  let oldLinesLeft = 0;
  let newLinesLeft = 0;

  for (const line of patch.split(/\r?\n/)) {
    const hunkMatch = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (hunkMatch) {
      inHunk = true;
      oldLinesLeft = hunkMatch[1] ? Number(hunkMatch[1]) : 1;
      newLinesLeft = hunkMatch[2] ? Number(hunkMatch[2]) : 1;
      lastOld = undefined;
      continue;
    }

    if (inHunk) {
      const ch = line[0];
      if (ch === '-') oldLinesLeft--;
      else if (ch === '+') newLinesLeft--;
      else if (ch === ' ' || ch === undefined) {
        // A blank context line that lost its leading space (emitted by many
        // diff tools and common in LLM/transmitted diffs) has line[0] ===
        // undefined. GNU patch tolerantly treats it as a context line; we must
        // match that leniency or neither counter decrements, inHunk never
        // terminates, and the next file's ---/+++ headers are consumed as hunk
        // content — defeating the pre-flight path-containment check.
        oldLinesLeft--;
        newLinesLeft--;
      }
      // '\' (no-newline marker) is not counted toward either side.
      if (oldLinesLeft <= 0 && newLinesLeft <= 0) inHunk = false;
      continue;
    }

    const oldMatch = /^---\s+([^\t\r\n]+)/.exec(line);
    if (oldMatch) {
      lastOld = clean(oldMatch[1]);
      continue;
    }
    const newMatch = /^\+\+\+\s+([^\t\r\n]+)/.exec(line);
    if (!newMatch) continue;
    const newTarget = clean(newMatch[1]);
    if (newTarget && newTarget !== '/dev/null') {
      out.push({ raw: newTarget, deleted: false });
    } else if (lastOld && lastOld !== '/dev/null') {
      out.push({ raw: lastOld, deleted: true });
    }
    // A `---`/`+++` pair is consumed together; do not let it bind to the next.
    lastOld = undefined;
  }
  return out;
}

/** Mimic `patch -pN` path stripping on a single target. Returns undefined
 *  if the path has fewer slash-runs than `strip`.
 *
 *  GNU patch counts "slashes, along with the directory names between them"
 *  (per the diffutils manual), where "a sequence of one or more adjacent
 *  slashes is counted as a single slash." For each strip count, one
 *  directory-name + slash-run pair is removed from the front.
 *
 *  The previous implementation filtered empty segments before counting, which
 *  collapsed leading slashes (e.g. `/a` → `["a"]`) and caused the preflight to
 *  strip one MORE component than GNU patch. For `/../etc/passwd` with -p1,
 *  GNU patch yields `../etc/passwd` (escapes root) while the old preflight
 *  yielded `etc/passwd` (in-root) — a containment bypass. */
function stripPathComponents(p: string, strip: number): string | undefined {
  const s = p.replace(/\\/g, '/');
  let idx = 0;
  for (let i = 0; i < strip; i++) {
    // Skip the directory name (non-slash characters — may be empty when
    // the path starts with '/', which is how -p1 on /foo/bar gives foo/bar).
    while (idx < s.length && s[idx] !== '/') idx++;
    // Skip the slash-run (one or more adjacent '/' chars counted as one).
    let hadSlash = false;
    while (idx < s.length && s[idx] === '/') {
      idx++;
      hadSlash = true;
    }
    if (!hadSlash) return undefined; // fewer slash-runs than strip
  }
  return s.slice(idx) || undefined;
}

function runPatch(
  args: string[],
  cwd: string,
  signal: AbortSignal,
  fallback: { patchFile: string; strip: number; dryRun: boolean },
): Promise<{ exitCode: number; stdout: string; stderr: string; engine: 'patch' | 'git' }> {
  return runPatchProcess('patch', args, cwd, signal).then(async (result) => {
    if (!result.unavailable) return { ...result, engine: 'patch' };

    // GNU patch is not installed by default on Windows. Git for Windows is
    // already a WrongStack prerequisite and `git apply` works outside a Git
    // worktree, so use it as a shell-free fallback. Path containment remains
    // enforced by the pre-flight above; --unsafe-paths only prevents Git from
    // applying its own repository-root policy to an already-validated target.
    const gitArgs = [
      'apply',
      '--unsafe-paths',
      `-p${fallback.strip}`,
      '--verbose',
      ...(fallback.dryRun ? ['--check'] : []),
      fallback.patchFile,
    ];
    const gitResult = await runPatchProcess('git', gitArgs, cwd, signal);
    return { ...gitResult, engine: 'git' };
  });
}

function runPatchProcess(
  command: 'patch' | 'git',
  args: string[],
  cwd: string,
  signal: AbortSignal,
): Promise<{ exitCode: number; stdout: string; stderr: string; unavailable: boolean }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';

    // Force C locale so `extractPatchedFiles` (which greps for the English
    // "patching file" prefix) doesn't silently miss-count on systems with
    // localized GNU patch output (fr/de/es etc.). Use buildChildEnv to
    // strip API keys and other secrets from the parent environment.
    const env = { ...buildChildEnv(), LANG: 'C', LC_ALL: 'C' };
    const child = spawn(command, args, {
      cwd,
      signal,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdout?.on('data', (c) => {
      stdout += c.toString();
    });
    child.stderr?.on('data', (c) => {
      stderr += c.toString();
    });
    child.on('close', (code) =>
      resolve({ exitCode: code ?? 1, stdout, stderr, unavailable: false }),
    );
    child.on('error', (e: NodeJS.ErrnoException) =>
      resolve({
        exitCode: 1,
        stdout: '',
        stderr: e.message,
        unavailable: e.code === 'ENOENT',
      }),
    );
  });
}

function extractPatchedFiles(output: string): string[] {
  const files: string[] = [];
  // In normal mode GNU patch prints "patching file X"; in --dry-run mode it
  // prints "checking file X" instead. Match both so dry-run previews report
  // the same file list as a real apply.
  const re = /(?:patching|checking) file (.+)/gi;
  for (const m of output.matchAll(re)) {
    if (m[1]) files.push(m[1]);
  }
  return files;
}
