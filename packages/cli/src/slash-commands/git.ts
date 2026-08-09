import { spawn } from 'node:child_process';
import { assessCommitSafety } from '@wrongstack/core/coordination';
import type { SlashCommand } from '@wrongstack/core/types';
import { color, toErrorMessage } from '@wrongstack/core/utils';
import type { SlashCommandContext } from './command-context.js';

// ── git child process ───────────────────────────────────────────────

export async function runGit(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn('git', args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        signal: AbortSignal.timeout(30_000),
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (d) => {
        stdout += d;
      });
      child.stderr?.on('data', (d) => {
        stderr += d;
      });
      child.on('error', (err) => {
        reject(new Error(`Failed to run git: ${err.message}`));
      });
      child.on('close', (code) => resolve({ stdout, stderr, code: code ?? 0 }));
    });
  } catch (err) {
    throw new Error(toErrorMessage(err));
  }
}

async function isGitRepo(cwd: string): Promise<boolean> {
  const result = await runGit(['rev-parse', '--git-dir'], cwd);
  return result.code === 0;
}

async function hasUncommittedChanges(cwd: string): Promise<boolean> {
  const result = await runGit(['status', '--porcelain'], cwd);
  return result.stdout.trim().length > 0;
}

// ── read-only repository overview ──────────────────────────────────

const GIT_STATUS_LINE_LIMIT = 100;
const GIT_SUMMARY_CHAR_LIMIT = 8_000;

interface GitOverview {
  branch: string | null;
  head: string | null;
  clean: boolean;
  changes: string[];
  changesTruncated: boolean;
  unstagedSummary: string;
  stagedSummary: string;
}

function truncateGitSummary(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= GIT_SUMMARY_CHAR_LIMIT) return trimmed;
  return `${trimmed.slice(0, GIT_SUMMARY_CHAR_LIMIT)}\n… (summary truncated)`;
}

async function readGitOverview(cwd: string): Promise<GitOverview> {
  const [branchResult, headResult, statusResult, unstagedResult, stagedResult] = await Promise.all([
    runGit(['branch', '--show-current'], cwd),
    runGit(['rev-parse', '--short', 'HEAD'], cwd),
    runGit(['status', '--short'], cwd),
    runGit(['diff', '--stat', '--no-color'], cwd),
    runGit(['diff', '--cached', '--stat', '--no-color'], cwd),
  ]);

  const allChanges = statusResult.stdout.split(/\r?\n/).filter(Boolean);
  return {
    branch: branchResult.stdout.trim() || null,
    head: headResult.code === 0 ? headResult.stdout.trim() || null : null,
    clean: allChanges.length === 0,
    changes: allChanges.slice(0, GIT_STATUS_LINE_LIMIT),
    changesTruncated: allChanges.length > GIT_STATUS_LINE_LIMIT,
    unstagedSummary: truncateGitSummary(unstagedResult.stdout),
    stagedSummary: truncateGitSummary(stagedResult.stdout),
  };
}

function renderGitOverview(overview: GitOverview): string {
  const identity = overview.head
    ? `${overview.branch ?? '(detached)'} @ ${overview.head}`
    : (overview.branch ?? '(unborn branch)');
  const lines = [
    color.bold('Git overview'),
    `  Branch: ${identity}`,
    overview.clean
      ? `  Working tree: ${color.green('clean')}`
      : `  Working tree: ${color.yellow(`${overview.changes.length}${overview.changesTruncated ? '+' : ''} changed path(s)`)}`,
  ];

  if (!overview.clean) {
    lines.push('', color.dim('Status'), ...overview.changes.map((line) => `  ${line}`));
    if (overview.changesTruncated) lines.push(color.dim('  … additional paths omitted'));
  }
  if (overview.unstagedSummary) {
    lines.push('', color.dim('Unstaged diff'), overview.unstagedSummary);
  }
  if (overview.stagedSummary) {
    lines.push('', color.dim('Staged diff'), overview.stagedSummary);
  }
  return lines.join('\n');
}

/**
 * Read-only operational Git command. Mutating workflows remain on `/commit`,
 * `/push`, and the permission-gated `git` tool.
 */
export function buildGitCommand(opts: SlashCommandContext): SlashCommand {
  const help = [
    'Usage: /git [status|branch|diff] [--staged] [--json]',
    '',
    '  status   Branch, HEAD, changed paths, and staged/unstaged diff summaries.',
    '  branch   Current branch and short HEAD.',
    '  diff     Diff summary; add --staged for the index.',
    '  --json   Emit stable machine-readable output.',
    '',
    'Mutations are intentionally handled by /commit, /push, or the permission-gated git tool.',
  ].join('\n');
  return {
    name: 'git',
    category: 'Inspect',
    argsHint: '[status|branch|diff] [--staged] [--json]',
    description: 'Show a concise, read-only repository overview.',
    help,
    async run(args: string) {
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const verb = tokens.find((token) => !token.startsWith('-'))?.toLowerCase() ?? 'status';
      const json = tokens.includes('--json');
      if (verb === 'help') return { message: help };
      if (!['status', 'branch', 'diff'].includes(verb)) {
        return { message: `Unknown subcommand "${verb}". Try: status | branch | diff.` };
      }

      const cwd = opts.cwd;
      if (!(await isGitRepo(cwd))) return { message: 'Not a git repository.' };

      const overview = await readGitOverview(cwd);
      if (json) {
        const payload =
          verb === 'branch'
            ? { branch: overview.branch, head: overview.head }
            : verb === 'diff'
              ? {
                  staged: tokens.includes('--staged'),
                  summary: tokens.includes('--staged')
                    ? overview.stagedSummary
                    : overview.unstagedSummary,
                }
              : overview;
        return { message: JSON.stringify(payload, null, 2), metadata: { git: payload } };
      }

      if (verb === 'branch') {
        return {
          message: `${overview.branch ?? '(detached)'}${overview.head ? ` @ ${overview.head}` : ''}`,
        };
      }
      if (verb === 'diff') {
        const staged = tokens.includes('--staged');
        const summary = staged ? overview.stagedSummary : overview.unstagedSummary;
        return { message: summary || `No ${staged ? 'staged' : 'unstaged'} changes.` };
      }
      return { message: renderGitOverview(overview), metadata: { git: overview } };
    },
  };
}

// ── commit message generation ───────────────────────────────────────

/**
 * Provider shape needed to draft a commit message. Mirrors the session
 * provider's `complete()` — we access it structurally so the command doesn't
 * depend on the concrete Provider type.
 */
interface CommitLLMProvider {
  complete(
    req: {
      model: string;
      system?: { type: 'text' | undefined; text: string }[];
      messages: { role: string; content: { type: 'text'; text: string }[] }[];
      maxTokens: number;
      temperature?: number | undefined;
    },
    opts: { signal: AbortSignal },
  ): Promise<{ content: unknown; model?: string | undefined }>;
}

function asLLMProvider(provider: unknown): CommitLLMProvider | null {
  if (provider && typeof (provider as CommitLLMProvider).complete === 'function') {
    return provider as CommitLLMProvider;
  }
  return null;
}

/**
 * Ask the LLM to draft a conventional-commit message from the diff. Returns
 * null on any failure so the caller can fall back to heuristics.
 */
async function generateCommitMessageWithLLM(
  diff: string,
  provider: CommitLLMProvider,
  model: string,
): Promise<string | null> {
  const systemPrompt =
    'You are a helpful assistant that generates concise, conventional-commit-formatted git commit messages. ' +
    'Analyze the provided diff and output ONLY the commit message (no explanation, no quotes). ' +
    'Format: <type>(<scope>): <short description> — <type> is one of: feat, fix, docs, style, refactor, test, chore, perf, ci, build, temp. ' +
    'If the diff contains multiple unrelated changes, pick the most important one. ' +
    'Keep the description under 72 characters. Example: feat(cli): add /commit LLM integration';

  try {
    const ac = new AbortController();
    const timeout = setTimeout(() => ac.abort(), 15_000);
    const resp = await provider.complete(
      {
        model,
        system: [{ type: 'text', text: systemPrompt }],
        messages: [
          { role: 'user', content: [{ type: 'text', text: `Here is the git diff:\n\n${diff}` }] },
        ],
        maxTokens: 80,
        temperature: 0.3,
      },
      { signal: ac.signal },
    );
    clearTimeout(timeout);

    const raw = resp.content;
    const text = Array.isArray(raw)
      ? ((raw[0] as { type: string; text?: string | undefined })?.text ?? '')
      : typeof raw === 'object' && raw !== null
        ? ((raw as { type: string; text?: string | undefined }).text ?? '')
        : String(raw ?? '');
    const message = text.trim().split('\n')[0] ?? '';
    if (message.length > 0 && message.length < 200) return message;
  } catch {
    // fall through to heuristics
  }
  return null;
}

function detectCommitType(stats: string): string {
  const lines = stats.split('\n');
  const hasTestFiles = lines.some(
    (l) => l.includes('_test.') || l.includes('.test.') || l.includes('.spec.'),
  );
  const hasDocs = lines.some(
    (l) =>
      l.includes('README') || l.includes('CHANGELOG') || l.includes('docs/') || l.includes('.md'),
  );
  const hasConfig = lines.some(
    (l) => l.includes('config') || l.includes('tsconfig') || l.includes('.json'),
  );
  if (hasTestFiles) return 'test';
  if (hasDocs) return 'docs';
  if (hasConfig) return 'chore';
  return 'feat';
}

async function generateCommitMessageHeuristics(cwd: string): Promise<string> {
  const statsResult = await runGit(['diff', '--stat'], cwd);
  if (statsResult.code !== 0) return 'chore: update';

  const nameResult = await runGit(['diff', '--name-only'], cwd);
  const files = nameResult.stdout.split('\n').filter(Boolean);
  const commitType = detectCommitType(statsResult.stdout);

  let scope = '';
  if (files.length > 0) {
    const primary = files[0]?.split('/')[0];
    if (primary && primary !== 'packages' && primary !== 'apps' && primary !== 'node_modules') {
      scope = `(${primary})`;
    }
  }

  if (files.length === 0) return `${commitType}${scope}: update`;
  if (files.length <= 3) {
    const summary = files.map((f) => f.split('/').pop()).join(', ');
    return `${commitType}${scope}: ${summary}`;
  }
  const summary = `${files
    .slice(0, 3)
    .map((f) => f.split('/').pop())
    .join(', ')} and ${files.length - 3} more`;
  return `${commitType}${scope}: ${summary}`;
}

// ── commands ────────────────────────────────────────────────────────

export function buildCommitCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'commit',
    description: 'Stage all changes and commit with auto-generated message.',
    aliases: ['gc'],
    async run(args: string) {
      const cwd = opts.cwd;

      if (!(await isGitRepo(cwd))) return { message: 'Not a git repository.' };
      if (!(await hasUncommittedChanges(cwd))) {
        return { message: 'Nothing to commit (working tree clean).' };
      }

      const dryRun = args.includes('--dry-run') || args.includes('-n');
      const noLlm = args.includes('--no-llm');

      // ═══ Shared-worktree / foreign-change detection ═══
      // `/commit` stages the whole working tree (`git add .`). When another
      // agent or a separate wrongstack process is editing the same tree, that
      // sweep captures their half-done work. Warn (loudly) before committing;
      // we don't change WHAT gets committed — the decision stays with the user.
      let worktreeWarning = '';
      try {
        const report = await assessCommitSafety({
          cwd,
          projectRoot: opts.projectRoot,
          sessionId: opts.context?.session?.id,
        });
        if (report.warning) {
          worktreeWarning = `\n${color.yellow(report.warning)}\n`;
        }
      } catch {
        // commit-safety is best-effort; never block a commit on it
      }

      // Draft message — LLM from the session provider first, heuristics on any
      // failure (no provider, timeout, empty result).
      let message: string | null = null;
      const provider = noLlm ? null : asLLMProvider(opts.llmProvider);
      if (provider && opts.llmModel) {
        const diff = (await runGit(['diff'], cwd)).stdout;
        message = await generateCommitMessageWithLLM(diff, provider, opts.llmModel);
      }
      if (!message) message = await generateCommitMessageHeuristics(cwd);

      if (dryRun) {
        const diffStat = (await runGit(['diff', '--stat'], cwd)).stdout || '(no changes)';
        return {
          message: [
            worktreeWarning,
            `${color.dim('Would commit:')}`,
            `  ${color.green(message)}`,
            '',
            `${color.dim(diffStat)}`,
            `${color.dim('(dry-run — no actual commit)')}`,
          ]
            .filter(Boolean)
            .join('\n'),
        };
      }

      const stageResult = await runGit(['add', '.'], cwd);
      if (stageResult.code !== 0) return { message: `Stage failed: ${stageResult.stderr}` };

      // Show staged diff before committing
      const diffStat = (await runGit(['diff', '--cached', '--stat'], cwd)).stdout || '';
      const fullDiff = (await runGit(['diff', '--cached'], cwd)).stdout || '';
      const diffPreview =
        fullDiff.length > 8000
          ? fullDiff.slice(0, 8000) + '\n\n... (diff truncated, showing first 8KB)'
          : fullDiff;

      const commitResult = await runGit(['commit', '-m', message], cwd);
      if (commitResult.code !== 0) return { message: `Commit failed: ${commitResult.stderr}` };

      const hash = (await runGit(['rev-parse', '--short', 'HEAD'], cwd)).stdout.trim();
      const hasRemote = (await runGit(['remote'], cwd)).stdout.trim().length > 0;
      const pushMsg = hasRemote ? `\n${color.dim('Tip: Run /push to push to remote')}` : '';

      return {
        message: [
          worktreeWarning,
          `${color.green('✓')} Committed: ${color.bold(message)}`,
          `  ${color.dim(hash)}`,
          '',
          color.dim('─── Staged diff ───────────────────────────────────────────────'),
          color.dim(diffStat),
          diffPreview ? color.dim(diffPreview) : '',
          pushMsg,
        ]
          .filter(Boolean)
          .join('\n'),
      };
    },
  };
}

export function buildGitcheckCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'gitcheck',
    description: 'Check for uncommitted changes (for system prompt integration).',
    aliases: ['gcstatus'],
    async run(_args: string) {
      const cwd = opts.cwd;
      if (!(await isGitRepo(cwd))) return { message: '' };
      if (!(await hasUncommittedChanges(cwd))) return { message: '' };

      const statusResult = await runGit(['status', '--porcelain'], cwd);
      const count = statusResult.stdout.split('\n').filter(Boolean).length;
      if (count === 0) return { message: '' };

      return {
        message: `⚠ ${color.yellow(`${count} uncommitted change${count > 1 ? 's' : ''}`)} — consider /commit`,
      };
    },
  };
}

export function buildPushCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'push',
    description: 'Push to remote after commit.',
    async run(args: string) {
      const cwd = opts.cwd;
      if (!(await isGitRepo(cwd))) return { message: 'Not a git repository.' };

      const dryRun = args.includes('--dry-run') || args.includes('-n');
      const force = args.includes('--force') || args.includes('-f');

      const remotes = (await runGit(['remote'], cwd)).stdout.split('\n').filter(Boolean);
      if (remotes.length === 0) {
        return { message: 'No remote configured. Add one with: git remote add origin <url>' };
      }

      if (dryRun) {
        return {
          message: `Would push to ${remotes.join(', ')}${force ? ' (force)' : ''}\n${color.dim('(dry-run)')}`,
        };
      }

      const branch =
        (await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)).stdout.trim() || 'main';
      const pushArgs = ['push'];
      if (force) pushArgs.push('--force');
      pushArgs.push(...remotes, branch);

      const pushResult = await runGit(pushArgs, cwd);
      if (pushResult.code !== 0) return { message: `Push failed: ${pushResult.stderr}` };

      return { message: `${color.green('✓')} Pushed to ${remotes.join(', ')} (${branch})` };
    },
  };
}
