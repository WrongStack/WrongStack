import { spawn } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { Context } from '@wrongstack/core/agent';
import type { ReviewContextBundle } from '@wrongstack/core/plugin';
import { emitReviewIfChanged } from '@wrongstack/core/plugin';
import type { SlashCommand } from '@wrongstack/core/types';
import type { SlashCommandContext } from './command-context.js';

// ── Git helpers (minimal copy — same logic as chimera-plugin) ────────────
async function runGit(args: string[], cwd: string): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: AbortSignal.timeout(10_000),
      windowsHide: true,
    });
    let stdout = '';
    child.stdout?.on('data', (d) => {
      stdout += d;
    });
    child.on('error', () => resolve({ stdout, code: 1 }));
    child.on('close', (code) => resolve({ stdout, code: code ?? 0 }));
  });
}

async function getChangedFiles(
  cwd: string,
): Promise<Array<{ path: string; status: 'added' | 'modified' }>> {
  const r = await runGit(['status', '--porcelain'], cwd);
  if (r.code !== 0) return [];
  const files: Array<{ path: string; status: 'added' | 'modified' }> = [];
  for (const line of r.stdout.split('\n')) {
    if (!line.trim()) continue;
    const statusCode = line.slice(0, 2).trim();
    const filePath = line.slice(3).trim();
    if (statusCode === 'A' || statusCode === 'A ' || statusCode === ' A' || statusCode === '??') {
      files.push({ path: filePath, status: 'added' });
    } else if (statusCode.includes('M')) {
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
          const n = Number.parseInt(tokens[++i] ?? '', 10);
          if (Number.isFinite(n) && n > 0) limit = Math.min(200, n);
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
