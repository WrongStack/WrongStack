import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Tool } from '@wrongstack/core/types';
import { buildChildEnv } from '@wrongstack/core/utils';
import { safeResolve, sha256hex } from './_util.js';

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
    '- On failure it creates .rej and .orig files for manual review.\n' +
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

    const dir = input.directory ? safeResolve(input.directory, ctx) : ctx.cwd;
    // strip=0 lets a diff address absolute paths like /etc/passwd and
    // escape the project root entirely. Force >= 1.
    const strip = Math.max(1, input.strip ?? 1);
    const dryRun = input.dry_run ?? false;

    // Pre-flight: scan diff target paths and reject any that resolve outside
    // the project root. This catches `../../../etc/passwd`-style escapes
    // before we hand the diff to GNU patch.
    const targets = extractDiffTargets(input.patch);
    const resolvedTargets: string[] = [];
    for (const t of targets) {
      const stripped = stripPathComponents(t, strip);
      if (!stripped) continue;
      const candidate = path.resolve(dir, stripped);
      const rel = path.relative(ctx.projectRoot, candidate);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        return {
          applied: 0,
          rejected: 1,
          files: [],
          dry_run: dryRun,
          message: `patch refused: target "${t}" resolves outside project root`,
        };
      }
      resolvedTargets.push(candidate);
    }

    // Snapshot target contents before applying so the change can be recorded
    // for session rewind and stale-read tracking (same bookkeeping as `edit`).
    const beforeContents = new Map<string, string | null>();
    if (!dryRun) {
      for (const target of resolvedTargets) {
        beforeContents.set(target, await readTextForTracking(target));
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

      const result = await runPatch(args, dir, opts.signal);

      if (result.exitCode !== 0 && !dryRun) {
        return {
          applied: 0,
          rejected: 1,
          files: [],
          dry_run: dryRun,
          message: `patch failed: ${result.stderr || result.stdout}`,
        };
      }

      const patched = extractPatchedFiles(result.stdout);

      // Record what actually changed: mtime + hash (tagged 'write' so the
      // permission bypass does not widen) so a later `edit` doesn't trip the
      // stale-read guard on our own write, plus the before/after pair for
      // session rewind.
      if (!dryRun) {
        for (const target of resolvedTargets) {
          const before = beforeContents.get(target) ?? null;
          const after = await readTextForTracking(target);
          if (after === null || after === before) continue;
          const stat = await fs.stat(target).catch(() => null);
          // Optional calls: embedders may hand in a duck-typed Context.
          if (stat) ctx.recordRead?.(target, stat.mtimeMs, 'write', sha256hex(after));
          ctx.session?.recordFileChange?.({
            path: target,
            action: before === null ? 'created' : 'modified',
            before,
            after,
          });
        }
      }

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

/** Extract every `+++ <path>` target from a unified diff. */
function extractDiffTargets(patch: string): string[] {
  const out: string[] = [];
  // Matches `+++ path/to/file` and `+++ b/path/to/file` (also `a/`). Strips
  // optional tab-prefixed timestamp suffixes that some diff tools emit.
  // Cap each line at 4096 chars to prevent maliciously long lines from
  // causing regex backtracking issues in large patches.
  const re = /^\+\+\+\s+([^\t\r\n]+)/gm;
  for (const m of patch.matchAll(re)) {
    const raw = m[1];
    if (!raw) continue;
    const target = raw.length > 4096 ? raw.slice(0, 4096).trim() : raw.trim();
    if (!target || target === '/dev/null') continue;
    out.push(target);
  }
  return out;
}

/** Mimic `patch -pN` path stripping on a single target. Returns undefined
 *  if the path has fewer segments than `strip`. */
function stripPathComponents(p: string, strip: number): string | undefined {
  // Normalize separators so the count works on both POSIX and Windows-style
  // paths embedded in LLM-generated diffs. Filter out empty segments (e.g.
  // from trailing slashes or `//` sequences) before counting.
  const parts = p
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s !== '' && s !== '.');
  if (parts.length <= strip) return undefined;
  return parts.slice(strip).join('/');
}

function runPatch(
  args: string[],
  cwd: string,
  signal: AbortSignal,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';

    // Force C locale so `extractPatchedFiles` (which greps for the English
    // "patching file" prefix) doesn't silently miss-count on systems with
    // localized GNU patch output (fr/de/es etc.). Use buildChildEnv to
    // strip API keys and other secrets from the parent environment.
    const env = { ...buildChildEnv(), LANG: 'C', LC_ALL: 'C' };
    const child = spawn('patch', args, {
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
    child.on('close', (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
    child.on('error', (e) => resolve({ exitCode: 1, stdout: '', stderr: e.message }));
  });
}

function extractPatchedFiles(output: string): string[] {
  const files: string[] = [];
  const re = /patching file (.+)/gi;
  for (const m of output.matchAll(re)) {
    if (m[1]) files.push(m[1]);
  }
  return files;
}
