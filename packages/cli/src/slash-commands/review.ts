import { spawn } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { SlashCommand } from '@wrongstack/contracts/types';
import type { Context } from '@wrongstack/core/agent';
import type { ReviewContextBundle } from '@wrongstack/core/plugin';
import { emitReviewIfChanged } from '@wrongstack/core/plugin';
import { gitIsolationEnv } from '@wrongstack/primitives';
import type { SlashCommandContext } from './command-context.js';

// ── Git helpers (minimal copy — same logic as chimera-plugin) ────────────
async function runGit(args: string[], cwd: string): Promise<{ stdout: string; code: number }> {
  // The repository's config names programs `status` runs (fsmonitor,
  // `.gitattributes` filters); when they cannot be switched off, git does not run.
  const isolation = await gitIsolationEnv(cwd);
  if (!isolation) return { stdout: '', code: 1 };
  return new Promise((resolve) => {
    const child = spawn('git', args, {
      cwd,
      env: { ...process.env, ...isolation },
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: AbortSignal.timeout(10_000),
      windowsHide: true,
    });
    let stdout = '';
    // Decode across chunks: `+= chunk` decodes each Buffer alone and turns a
    // multibyte UTF-8 character split at a pipe-chunk boundary into U+FFFD.
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (d) => {
      stdout += d;
    });
    child.on('error', () => resolve({ stdout, code: 1 }));
    // `code` is null only when git was killed by a signal — never a success.
    child.on('close', (code) => resolve({ stdout, code: code ?? 1 }));
  });
}

async function getChangedFiles(
  cwd: string,
): Promise<Array<{ path: string; status: 'added' | 'modified' }>> {
  // -z: line output C-quotes names with spaces/non-ASCII (`"my notes.ts"`), which
  // then fail fs.access and drop out of review. -uall: a new directory is one
  // `?? dir/` entry otherwise, and the files inside it were never reviewed.
  const r = await runGit(['status', '--porcelain', '-z', '--untracked-files=all'], cwd);
  if (r.code !== 0) return [];
  // Porcelain paths are repository-root relative whatever the cwd; a project
  // opened in a subdirectory keeps its own entries, made cwd-relative.
  const prefixRun = await runGit(['rev-parse', '--show-prefix'], cwd);
  if (prefixRun.code !== 0) return [];
  const prefix = prefixRun.stdout.trim();
  const files: Array<{ path: string; status: 'added' | 'modified' }> = [];
  const records = r.stdout.split('\0');
  for (let i = 0; i < records.length; i++) {
    const record = records[i] ?? '';
    if (record.length < 4) continue;
    const statusCode = record.slice(0, 2).trim();
    const repoPath = record.slice(3);
    // A rename/copy record is followed by its source path.
    const renamed = statusCode.includes('R') || statusCode.includes('C');
    if (renamed) i++;
    if (!repoPath.startsWith(prefix)) continue;
    const filePath = repoPath.slice(prefix.length);
    if (statusCode === 'A' || statusCode === 'A ' || statusCode === ' A' || statusCode === '??') {
      files.push({ path: filePath, status: 'added' });
    } else if (statusCode.includes('M') || renamed) {
      // A staged rename (`R `) is how `git mv` + edits shows up — git reports
      // the move, not an `M`, yet the destination's content is what changed.
      files.push({ path: filePath, status: 'modified' });
    }
  }
  return files;
}

export function buildReviewCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'review',
    category: 'Session',
    aliases: ['cr'],
    description: 'Manually trigger a Chimera code review of changed files.',
    help: [
      '╔═══ Chimera Review ═══╗',
      '',
      'Manually review files changed in this session using the',
      'read-only Chimera subagent (read, grep, glob, tree, index search).',
      '',
      'Usage:',
      '  /review                    Review all changed files (up to 30)',
      '  /review --limit <n>        Raise/lower the file cap (1–200)',
      '  /review --files <substr>   Only review changed files whose path contains <substr>',
    ].join('\n'),
    async run(args: string, ctx: Context) {
      const cwd = ctx.cwd;

      // Parse flags: --limit <n> overrides the 30-file cap; --files <substr>
      // filters the changed set by path substring.
      const tokens = (args ?? '').trim().split(/\s+/).filter(Boolean);
      let limit = 30;
      let fileFilter: string | undefined;
      for (let i = 0; i < tokens.length; i++) {
        const tok = (tokens[i] ?? '').toLowerCase();
        if ((tok === '--limit' || tok === '-n') && tokens[i + 1]) {
          const raw = tokens[++i] ?? '';
          if (!/^\d+$/.test(raw)) {
            return { message: `Invalid --limit "${raw}". Use a positive integer.` };
          }
          const n = Number(raw);
          if (!Number.isFinite(n)) {
            return { message: `Invalid --limit "${raw}". Use a positive integer.` };
          }
          if (n > 0) limit = Math.min(200, n);
        } else if ((tok === '--files' || tok === '--file') && tokens[i + 1]) {
          fileFilter = (tokens[++i] ?? '').toLowerCase();
        }
      }

      const allChanged = await getChangedFiles(cwd);
      const existing: Array<{ path: string; status: 'added' | 'modified' }> = [];
      for (const f of allChanged) {
        if (f.path.startsWith('.wrongstack/')) continue;
        if (fileFilter && !f.path.toLowerCase().includes(fileFilter)) continue;
        try {
          await fsp.access(path.join(cwd, f.path));
          existing.push(f);
        } catch {
          /* deleted */
        }
      }

      if (existing.length === 0) {
        return {
          message: fileFilter
            ? `No changed files matching "${fileFilter}" to review.`
            : 'No changed files to review.',
        };
      }

      const truncated = existing.length > limit;
      // Read files and emit chimera.review_needed event
      const filesWithContent: Array<{
        path: string;
        status: 'added' | 'modified';
        content: string;
      }> = [];
      for (const f of existing.slice(0, limit)) {
        try {
          const content = await fsp.readFile(path.join(cwd, f.path), 'utf8');
          filesWithContent.push({ ...f, content });
        } catch {
          /* skip */
        }
      }

      // Emit custom event — execution.ts picks this up. Claims are installed
      // in the shared ledger BEFORE the event fires (like the automatic
      // paths), so a concurrent session cannot review the same content and the
      // execution owner can release the claims if no Director is present.
      const payload: ReviewContextBundle = {
        config: {
          enabled: true,
          provider: ctx.provider.id,
          model: ctx.model,
          maxFiles: limit,
          autoFix: 'off',
          cascadeOn: 'off',
          maxCascadeDepth: 0,
          fallbackModels: [],
          fallbackProfile: undefined,
        },
        cwd,
        files: filesWithContent,
      };

      const emitted = await emitReviewIfChanged(
        { events: opts.events, emitCustom: opts.events.emitCustom.bind(opts.events) },
        payload,
      );
      if (!emitted) {
        return {
          message:
            '🦂 Chimera review skipped — this file content already has a review in progress.',
        };
      }

      const skipped = filesWithContent.length - emitted.files.length;
      const note = truncated
        ? `\n${existing.length - limit} more changed file(s) were not included — raise the cap with /review --limit ${existing.length}.`
        : '';
      const skippedNote =
        skipped > 0 ? ` ${skipped} file(s) already under review were skipped.` : '';
      return {
        message: `🦂 Chimera review triggered for ${emitted.files.length} file(s).${skippedNote}\nThe review report will appear in chat history shortly.${note}`,
      };
    },
  };
}
