/**
 * git-autocommit plugin — AI-powered git staging and commit message generation.
 *
 * Tools registered:
 * - git_autocommit: Stage files and create a commit with AI-written conventional commit messages.
 *   Supports `files` for specific staging, `paths` for scoped pathspec staging,
 *   and `dry_run` for preview.
 *
 * Scope guard (2026-08): this tool previously committed the ENTIRE git index,
 * and auto-staged every changed file in the tree when the index was empty —
 * while its own `autoStage: false` default was never consulted. On a shared
 * working tree that let one agent's commit absorb files another process had
 * staged concurrently (observed: a release commit absorbed a concurrently
 * staged workstream it never asked for). The guard:
 *   - `files` callers commit via `git commit --only -- <files>` — exactly
 *     those paths; anything else staged stays in the index for its owner.
 *   - `paths` callers stage ONLY changed files matching the pathspecs (git
 *     resolves the globs) and commit those, fenced the same way.
 *   - With no files/paths and an empty index, the tool now honors `autoStage`
 *     (default false) and returns an instructive error instead of silently
 *     staging the whole tree. Set `autoStage: true` for the legacy behavior.
 *
 * Note: The former `git_autocommit` and `git_autocommit` tools have been removed.
 * - For staging: use `git_autocommit` with `files` or `paths` (it stages automatically), or `bash` with `git add`.
 * - For status: use the built-in `git` tool with `command: "status"` or `command: "diff"`.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Plugin } from '@wrongstack/core/types';

const API_VERSION = '^0.1.10';

type ConventionalType =
  | 'feat'
  | 'fix'
  | 'docs'
  | 'style'
  | 'refactor'
  | 'test'
  | 'chore'
  | 'perf'
  | 'ci'
  | 'build'
  | 'revert';

// Module-level state, shared between `setup`, `teardown`, and `health`.
//
// Why module-level? The Plugin interface in @wrongstack/core does not
// thread state from `setup` → `teardown`. Today `git-autocommit` holds
// no in-process resources (everything goes through `execFile`, the
// async variant),
// but `health()` wants to report a commit count and last-commit hash
// that survive the function-call boundary — and a future reload-cycle
// audit could turn those into resource-tracking requirements the same
// way `cron` and `file-watcher` needed timers cleared (H1 audit,
// 2026-06-03). Module-level state is the path of least friction: it
// gives `teardown` something concrete to reset and `health()` something
// concrete to report. Setup re-zeros the counters (idempotent re-init
// on plugin reload); teardown clears them and logs.
const commitCount = { value: 0 };
const lastCommit = { hash: null as string | null, at: null as string | null };
/** Commits whose message was written by the LLM this session. */
const llmGenerated = { value: 0 };

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

const DEFAULT_GIT_TIMEOUT_MS = 30_000;
// `git commit` runs repository hooks. In this repo the pre-commit hook can
// rebuild packages and run workspace typecheck, which routinely exceeds the
// short timeout appropriate for read-only git commands.
const GIT_COMMIT_TIMEOUT_MS = 5 * 60_000;

async function runGit(
  args: string[],
  cwd?: string,
  timeoutMs = DEFAULT_GIT_TIMEOUT_MS,
): Promise<string> {
  return await new Promise<string>((resolvePromise, rejectPromise) => {
    execFile(
      'git',
      args,
      {
        encoding: 'utf-8',
        cwd,
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
      },
      (err, stdout) => {
        if (err) {
          const e = err as NodeJS.ErrnoException & {
            message?: string;
            stderr?: string;
          };
          rejectPromise(new Error(`git command failed: ${e.message ?? e.stderr ?? String(err)}`));
          return;
        }
        resolvePromise(stdout.trim());
      },
    );
  });
}

/**
 * Undo git's C-style quoting of a porcelain path.
 *
 * git quotes any path containing a space, a quote, a backslash, a control
 * character, or a non-ASCII byte (unless `core.quotePath=false`). Taking the
 * raw slice left the surrounding quotes attached, so the path never
 * matched a real file and the change was silently dropped from the commit.
 */
function unquotePorcelainPath(raw: string): string {
  if (!raw.startsWith('"') || !raw.endsWith('"') || raw.length < 2) return raw;
  const inner = raw.slice(1, -1);

  // Decode into BYTES, then interpret the whole buffer as UTF-8.
  //
  // git escapes each non-ASCII byte separately (`é` becomes `\303\251`), so
  // decoding escape-by-escape into characters yields the mojibake `Ã©` —
  // which matches no file on disk, and the change would be dropped exactly
  // as it was before this parsing existed. The bytes have to be reassembled
  // before decoding.
  const bytes: number[] = [];
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (ch !== '\\') {
      // Non-escaped run: push its UTF-8 encoding verbatim.
      for (const b of Buffer.from(ch, 'utf8')) bytes.push(b);
      continue;
    }
    const next = inner[i + 1];
    if (next === undefined) {
      bytes.push(0x5c); // trailing lone backslash
      break;
    }
    const simple: Record<string, number> = {
      n: 0x0a,
      t: 0x09,
      r: 0x0d,
      a: 0x07,
      b: 0x08,
      f: 0x0c,
      v: 0x0b,
      '"': 0x22,
      '\\': 0x5c,
    };
    const mapped = simple[next];
    if (mapped !== undefined) {
      bytes.push(mapped);
      i += 1;
      continue;
    }
    const octal = /^[0-7]{1,3}/.exec(inner.slice(i + 1));
    if (octal) {
      bytes.push(Number.parseInt(octal[0], 8) & 0xff);
      i += octal[0].length;
      continue;
    }
    // Unknown escape — keep the character as written.
    for (const b of Buffer.from(next, 'utf8')) bytes.push(b);
    i += 1;
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * Parse one `git status --porcelain` line into the path to stage.
 *
 * Two shapes the naive `line.slice(3)` got wrong:
 *  - **Renames/copies** print `R  old -> new`. Slicing produced the literal
 *    string `"old -> new"`, which matches no file on disk, so the rename was
 *    dropped from the commit entirely. The path that must be staged is the
 *    NEW one.
 *  - **Quoted paths** (spaces, unicode, control chars) keep their quotes,
 *    likewise matching nothing.
 */
export function parsePorcelainLine(line: string): string | null {
  // XY<space>PATH — the status code is always the first two columns.
  // CAVEAT: `runGit` resolves with `stdout.trim()`, which eats the leading
  // space of the FIRST porcelain line whenever the index column is blank
  // (` M path` → `M path`). That is precisely the unstaged-modified shape
  // the auto-stage path feeds through here, and slicing 3 off the trimmed
  // line silently dropped the path's first character ('auto.ts' became
  // 'uto.ts' — a file that does not exist, dropped by stageFiles' existence
  // filter). Detect the trimmed one-column shape and parse it as XY=' M'.
  const twoColumn = /^[MADRCUTX?! ]{2} /.test(line);
  const oneColumnTrimmed = !twoColumn && /^[MADRCUTX?!] /.test(line);
  if (!twoColumn && !oneColumnTrimmed) {
    // Not a porcelain line shape we recognize — fall back to the historical
    // 3-column slice so unknown future codes still parse positionally.
    const bodyAny = line.slice(3);
    return bodyAny ? unquotePorcelainPath(bodyAny.trim()) : null;
  }
  const body = oneColumnTrimmed ? line.slice(2) : line.slice(3);
  if (!body) return null;
  const status = oneColumnTrimmed ? ` ${line.slice(0, 1)}` : line.slice(0, 2);
  if (status.includes('R') || status.includes('C')) {
    // `old -> new`, either side possibly quoted. Stage the destination.
    const arrow = body.lastIndexOf(' -> ');
    if (arrow !== -1) return unquotePorcelainPath(body.slice(arrow + 4).trim());
  }
  return unquotePorcelainPath(body.trim());
}

async function getChangedFiles(cwd?: string): Promise<string[]> {
  const output = await runGit(['status', '--porcelain'], cwd);
  if (!output) return [];
  return output
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => parsePorcelainLine(l))
    .filter((p): p is string => p !== null && p.length > 0);
}

async function getStagedFiles(cwd?: string): Promise<string[]> {
  const output = await runGit(['diff', '--cached', '--name-only'], cwd);
  return output ? output.split('\n').filter(Boolean) : [];
}

/**
 * Staged files limited to a pathspec scope — the caller's own slice of the
 * index, excluding anything another process staged concurrently.
 */
async function getScopedStagedFiles(paths: string[], cwd?: string): Promise<string[]> {
  const output = await runGit(['diff', '--cached', '--name-only', '--', ...paths], cwd);
  return output ? output.split('\n').filter(Boolean) : [];
}

/**
 * Stage explicit file paths (filtered to files that exist) or raw git
 * pathspecs (any pattern containing `*`, `?` or `[` — matched by git itself,
 * e.g. all of `website/` recursively, or every package.json manifest at any
 * depth). The existence filter cannot apply to patterns, because which
 * files a pattern matches is git's to say.
 */
async function stageFiles(files: string[] | undefined, cwd?: string): Promise<void> {
  /* v8 ignore next -- callers always pass a validated array; the guard is defensive. */
  if (!files || !Array.isArray(files) || files.length === 0) return;
  const hasPattern = files.some((f) => /[*?[\]]/.test(f));
  if (!hasPattern) {
    // Filter to only files that exist (avoids "pathspec did not match any files" errors for typos)
    // Resolves against cwd for correct multi-root staging.
    const existing = (files as string[]).filter((f) => {
      try {
        return existsSync(cwd ? resolve(cwd, f) : f);
      } catch {
        return false;
      }
    });
    if (existing.length === 0) {
      throw new Error('Failed to stage files: none of the specified files exist on disk');
    }
    // `--` terminates option parsing: without it a file named `-f` or
    // `--force` would be read by git as a flag rather than a pathspec.
    await runGit(['add', '--', ...existing], cwd);
    return;
  }
  await runGit(['add', '--', ...files], cwd);
}

async function commitWithMessage(
  message: string,
  cwd?: string,
  /**
   * Scope fence: `git commit --only -- <paths>` makes the commit contain
   * exactly these paths and leaves anything else another process staged in
   * the index, unabsorbed. Without it, git commits the ENTIRE index — the
   * mechanism by which a release agent's commit absorbed a concurrently
   * staged workstream it never asked for.
   */
  paths?: string[],
): Promise<string> {
  const scoped = paths && paths.length > 0 ? ['--only', '--', ...paths] : [];
  return await runGit(['commit', '-m', message, ...scoped], cwd, GIT_COMMIT_TIMEOUT_MS);
}

/**
 * Working-tree paths among `paths` whose content no longer matches the index.
 *
 * `git commit --only` takes the named paths' content from the WORKING TREE,
 * not the staged index — so an edit landing between this tool's `git add`
 * and its commit would be committed even though it never appeared in the
 * dry-run preview or the LLM prompt. The caller aborts when this returns
 * any path; a re-run re-stages the current content and proceeds.
 *
 * Fail-open on git errors: the `--only` fence still bounds the blast radius
 * to these paths either way.
 */
async function scopedPathsDrifted(paths: string[], cwd?: string): Promise<string[]> {
  try {
    const out = await runGit(['diff', '--name-only', '--', ...paths], cwd);
    return out ? out.split('\n').filter(Boolean) : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Worktree / simultaneous-edit detection
// ---------------------------------------------------------------------------

interface WorktreeInfo {
  path: string;
  head: string;
  branch: string;
}

/** Parse `git worktree list --porcelain` into structured entries. */
async function getWorktrees(cwd?: string): Promise<WorktreeInfo[]> {
  try {
    const out = await runGit(['worktree', 'list', '--porcelain'], cwd);
    if (!out) return [];
    const entries: WorktreeInfo[] = [];
    let current: Partial<WorktreeInfo> = {};
    for (const line of out.split('\n')) {
      if (line === '') {
        if (current.path) entries.push(current as WorktreeInfo);
        current = {};
        continue;
      }
      if (line.startsWith('worktree ')) current.path = line.slice(9);
      else if (line.startsWith('HEAD ')) current.head = line.slice(5);
      else if (line.startsWith('branch ')) current.branch = line.slice(7);
    }
    if (current.path) entries.push(current as WorktreeInfo);
    return entries;
  } catch {
    return [];
  }
}

/**
 * Return a warning string when other worktrees exist besides the main one.
 * Multiple worktrees mean other agents may be making simultaneous changes.
 */
async function simultaneousEditWarning(cwd?: string): Promise<string | null> {
  const worktrees = await getWorktrees(cwd);
  if (worktrees.length > 1) {
    const otherBranches = worktrees
      .filter((wt) => wt.branch)
      .map((wt) => wt.branch.replace('refs/heads/', ''));
    return (
      `⚠ Simultaneous edits detected: ${worktrees.length} active worktrees ` +
      `(${otherBranches.join(', ')}). Changes from other agents may mix ` +
      'into this commit. Consider using worktree isolation or verifying ' +
      'the diff below before committing.'
    );
  }
  return null;
}

/** Run git diff --cached and return both stat and full diff. */
async function getStagedDiff(cwd?: string): Promise<{ stat: string; diff: string }> {
  try {
    const stat = await runGit(['diff', '--cached', '--stat'], cwd);
    // Limit full diff to prevent blowing up tool output
    const diff = await runGit(['diff', '--cached'], cwd);
    const MAX_DIFF = 20_000;
    const truncated =
      diff.length > MAX_DIFF ? diff.slice(0, MAX_DIFF) + '\n\n... (diff truncated)' : diff;
    return { stat: stat || '(no stat)', diff: truncated || '(clean)' };
  } catch {
    return { stat: '(unavailable)', diff: '(unavailable)' };
  }
}

/**
 * Run `git diff --cached --stat/-- <paths>` scoped to the commit's own
 * pathspec slice, for the dry-run preview and LLM message generation.
 */
async function getScopedStagedDiff(
  paths: string[],
  cwd?: string,
): Promise<{ stat: string; diff: string }> {
  try {
    const stat = await runGit(['diff', '--cached', '--stat', '--', ...paths], cwd);
    const diff = await runGit(['diff', '--cached', '--', ...paths], cwd);
    const MAX_DIFF = 20_000;
    const truncated =
      diff.length > MAX_DIFF ? diff.slice(0, MAX_DIFF) + '\n\n... (diff truncated)' : diff;
    return { stat: stat || '(no stat)', diff: truncated || '(clean)' };
  } catch {
    return { stat: '(unavailable)', diff: '(unavailable)' };
  }
}

/**
 * Check for files modified by external agents AFTER staging but BEFORE commit.
 * Runs `git status --porcelain`; flags any unstaged changes (modified or
 * untracked files) that appeared since the last `git add`. This catches
 * simultaneous edits from agents working in the same directory without
 * worktree isolation.
 */
async function externalChangesSinceStage(cwd?: string): Promise<string[] | null> {
  try {
    const out = await runGit(['status', '--porcelain'], cwd);
    if (!out) return null;
    const unstaged = out
      .split('\n')
      .filter((l) => l.trim())
      .filter((l) => {
        // index column = ' ' or '?' means the change is NOT staged
        /* v8 ignore next -- non-empty lines guarantee l[0] is defined; the ?? ' ' fallback is defensive. */
        const idx = l[0] ?? ' ';
        // ' M' = modified in worktree, not staged
        // '??' = untracked
        return idx === ' ' || idx === '?';
      })
      // Same parser as `getChangedFiles`: a quoted path reported raw would
      // surface to the user with its git quoting still attached.
      .map((l) => parsePorcelainLine(l))
      .filter((p): p is string => p !== null && p.length > 0);
    return unstaged.length > 0 ? unstaged : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Commit message generation
// ---------------------------------------------------------------------------

function generateCommitMessage(
  type: ConventionalType,
  scope: string | undefined,
  summary: string,
  body?: string | undefined,
): string {
  const scopePart = scope ? `(${scope})` : '';
  const footer = body ? `\n\n${body}` : '';
  return `${type}${scopePart}: ${summary}${footer}`;
}

const VALID_TYPES: ConventionalType[] = [
  'feat',
  'fix',
  'docs',
  'style',
  'refactor',
  'test',
  'chore',
  'perf',
  'ci',
  'build',
  'revert',
];

/**
 * Ask the host LLM (`api.llm`) for a conventional commit message from the
 * staged diff. Returns null on any failure (no api.llm, provider error, or
 * an unparseable / invalid response) so the caller keeps whatever the user
 * supplied. Provider/model follow `config.extensions['git-autocommit'].llm`,
 * then the session default.
 */
async function generateCommitFromDiff(
  api: Parameters<Plugin['setup']>[0],
  stat: string,
  diff: string,
): Promise<{ type: ConventionalType; scope?: string; summary: string; body?: string } | null> {
  if (!api.llm) return null;
  try {
    const result = await api.llm.complete(
      'Write a Conventional Commits message for this staged git diff. ' +
        'Respond with ONLY a JSON object of the form ' +
        '{"type": string, "scope": string, "summary": string, "body": string}. ' +
        `type is one of: ${VALID_TYPES.join(', ')}. ` +
        'scope is a short area (empty string if unclear). summary is an imperative, ' +
        'lower-case, <=72-char subject with no trailing period. body is an optional ' +
        'short explanation (empty string if not needed). No prose outside the JSON.\n\n' +
        `Stat:\n${stat}\n\nDiff:\n${diff}`,
      {
        system:
          'You are a precise release engineer writing Conventional Commits. Output only JSON.',
        role: 'document',
        maxTokens: 400,
        responseFormat: 'json',
      },
    );
    const parsed = JSON.parse(extractJsonObject(result.text)) as {
      type?: unknown;
      scope?: unknown;
      summary?: unknown;
      body?: unknown;
    };
    const type = VALID_TYPES.includes(parsed.type as ConventionalType)
      ? (parsed.type as ConventionalType)
      : null;
    const summary =
      typeof parsed.summary === 'string' && parsed.summary.trim() ? parsed.summary.trim() : null;
    if (!type || !summary) return null;
    const scope =
      typeof parsed.scope === 'string' && parsed.scope.trim() ? parsed.scope.trim() : undefined;
    const body =
      typeof parsed.body === 'string' && parsed.body.trim() ? parsed.body.trim() : undefined;
    return { type, summary, ...(scope ? { scope } : {}), ...(body ? { body } : {}) };
  } catch {
    return null;
  }
}

/** Pull the first {...} JSON object out of a possibly-fenced response. */
function extractJsonObject(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced?.[1] ?? text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  return start >= 0 && end > start ? body.slice(start, end + 1) : body.trim();
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: 'git-autocommit',
  version: '0.3.0',
  description: 'AI-powered git staging and conventional commit message generation',
  apiVersion: API_VERSION,
  capabilities: { tools: true, llm: true },
  defaultConfig: {
    conventionalCommits: true,
    autoStage: false,
    defaultType: 'feat',
    useLlm: false,
  },
  configSchema: {
    type: 'object',
    properties: {
      conventionalCommits: { type: 'boolean', default: true },
      autoStage: {
        type: 'boolean',
        default: false,
        description:
          'When the index is empty and no files/paths were given, stage every changed file before committing (legacy whole-tree behavior). Default false: the tool returns an instructive error instead, so a commit never absorbs unrelated concurrently staged work.',
      },
      defaultType: { type: 'string', default: 'feat' },
      useLlm: {
        type: 'boolean',
        default: false,
        description:
          'Auto-generate the commit message with the LLM (api.llm) when the caller supplies neither type nor message. Provider/model follow extensions["git-autocommit"].llm, then the session default.',
      },
      llm: {
        type: 'object',
        description: 'Optional { provider, model } override for LLM commit messages.',
      },
    },
  },

  setup(api) {
    // Idempotent re-init: zero the counters on every reload so the
    // counters reported by health() reflect the current plugin lifetime,
    // not the accumulated history across reloads.
    commitCount.value = 0;
    llmGenerated.value = 0;
    lastCommit.hash = null;
    lastCommit.at = null;

    const extConfig = api.config.extensions?.['git-autocommit'] as
      | Record<string, unknown>
      | undefined;
    const opts = {
      conventionalCommits: (extConfig?.['conventionalCommits'] as boolean) ?? true,
      autoStage: (extConfig?.['autoStage'] as boolean) ?? false,
      defaultType: (extConfig?.['defaultType'] as string) ?? 'feat',
      // Opt-in: when true, git_autocommit writes the commit message with
      // the LLM from the staged diff whenever the caller supplies neither
      // `type` nor `message` (an explicit `generate: true` always asks).
      useLlm: (extConfig?.['useLlm'] as boolean) ?? false,
    };

    // --- git_autocommit tool ---
    api.tools.register({
      name: 'git_autocommit',
      description:
        'Stage files and create a git commit with an AI-generated conventional commit message. Pass files for exact paths, or paths (git pathspec globs like "**/package.json", "website/**") to stage only matching changed files. Commits are fenced to the staged scope — unrelated concurrently staged files are left in the index, not absorbed.',
      inputSchema: {
        type: 'object',
        properties: {
          files: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Specific files to stage and commit. The commit is fenced to exactly these paths.',
          },
          paths: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Git pathspec globs limiting what this commit may include (e.g. ["**/package.json", "CHANGELOG.md", "website/**"] for a release). Only changed files matching these patterns are staged and committed.',
          },
          type: {
            type: 'string',
            enum: [
              'feat',
              'fix',
              'docs',
              'style',
              'refactor',
              'test',
              'chore',
              'perf',
              'ci',
              'build',
              'revert',
            ],
            description: 'Conventional commit type',
          },
          scope: { type: 'string', description: 'Commit scope (e.g. auth, api, ui)' },
          message: { type: 'string', description: 'Commit summary message' },
          body: { type: 'string', description: 'Optional commit body/description' },
          generate: {
            type: 'boolean',
            description:
              'Write the conventional commit message with the LLM (api.llm) from the staged diff. Ignored when no LLM is wired.',
          },
          dry_run: {
            type: 'boolean',
            default: false,
            description: 'Show what would be committed without committing',
          },
        },
      },
      permission: 'confirm',
      category: 'Git',
      mutating: true,
      async execute(input: Record<string, unknown>, _ctx) {
        try {
          let type = input['type'] as ConventionalType | undefined;
          let scope = input['scope'] as string | undefined;
          let summary = (input['message'] as string | undefined) ?? '';
          let body = input['body'] as string | undefined;
          const dryRun = (input['dry_run'] as boolean) ?? false;

          // LLM message generation is opt-in and only runs when the host
          // wired `api.llm`: an explicit `generate: true`, or the `useLlm`
          // config flag when the caller supplied neither type nor message.
          const explicitAsk = input['generate'] === true;
          const autoAsk =
            opts.useLlm && !input['type'] && !(input['message'] as string | undefined);
          const wantGenerate = (explicitAsk || autoAsk) && Boolean(api.llm);

          // Validate files input shape early.
          let files: string[] | undefined;
          const rawFiles = input['files'];
          if (rawFiles !== undefined) {
            if (!Array.isArray(rawFiles)) {
              return { ok: false, error: 'files must be an array of file paths' };
            }
            files = rawFiles;
          }

          // Validate paths input shape early.
          let pathspecs: string[] | undefined;
          const rawPaths = input['paths'];
          if (rawPaths !== undefined) {
            if (!Array.isArray(rawPaths)) {
              return { ok: false, error: 'paths must be an array of pathspec patterns' };
            }
            pathspecs = rawPaths.filter((p): p is string => typeof p === 'string' && p.length > 0);
            if (pathspecs.length === 0) {
              return { ok: false, error: 'paths must contain at least one non-empty pattern' };
            }
            // Reject the combination rather than silently dropping one side:
            // previously `files` was ignored whenever `paths` was present.
            if (files && files.length > 0) {
              return {
                ok: false,
                error:
                  'Pass either files (exact paths) or paths (pathspec globs), not both — the other would be silently ignored.',
              };
            }
          }

          // --- Scope guard: resolve what this call owns before touching git.
          //
          // `commitScope` is the concrete path list the commit is fenced to
          // (via `git commit --only`). `staged` is the reported payload.
          let commitScope: string[] | undefined;
          let staged: string[] = [];

          if (pathspecs) {
            // Pathspec flow: stage ONLY changed files matching the patterns,
            // then read back the concrete matching slice of the index.
            try {
              await stageFiles(pathspecs);
            } catch (err: unknown) {
              return {
                ok: false,
                error: `Failed to stage files matching paths: ${err instanceof Error ? err.message : String(err)}`,
              };
            }
            try {
              staged = await getScopedStagedFiles(pathspecs);
            } catch {
              staged = [];
            }
            if (staged.length === 0) {
              return {
                ok: false,
                error:
                  'No changed files match the given paths — refusing to commit anything else.',
              };
            }
            commitScope = staged;
            // Read the FULL index for the scope-guard warning below. The
            // scoped readback alone would hide foreign staged files, making
            // the warning permanently empty on this flow.
            try {
              staged = await getStagedFiles();
            } catch {
              staged = commitScope;
            }
          } else if (files && files.length > 0) {
            // Exact-files flow: stage them; the commit below is fenced to
            // exactly these paths.
            try {
              await stageFiles(files);
            } catch (err: unknown) {
              /* v8 ignore next -- stageFiles only throws Error; the String(err) branch is defensive. */
              return {
                ok: false,
                error: `Failed to stage files: ${err instanceof Error ? err.message : String(err)}`,
              };
            }
            commitScope = files;
            try {
              staged = await getStagedFiles();
            } catch {
              staged = [];
            }
          } else {
            // Legacy flow: use whatever is already staged. With an empty
            // index, the previous code silently staged EVERY changed file in
            // the tree — on a shared checkout that absorbed unrelated work
            // into this commit. That whole-tree behavior is now gated behind
            // `autoStage` (default false); an empty index falls through to
            // the "Nothing staged" error below with guidance instead.
            try {
              staged = await getStagedFiles();
            } catch {
              staged = [];
            }
            if (staged.length === 0 && opts.autoStage) {
              try {
                const changed = await getChangedFiles();
                if (changed.length > 0) {
                  try {
                    await stageFiles(changed);
                  } catch {
                    /* ignore staging errors */
                  }
                  try {
                    staged = await getStagedFiles();
                  } catch {
                    staged = [];
                  }
                }
              } catch {
                /* ignore */
              }
            }
            // Unscoped legacy commit: `commitScope` stays undefined and the
            // commit includes the full index (the pre-guard behavior, now
            // reachable only with pre-staged content or autoStage=true).
          }

          // Compute the staged diff once — used for LLM generation, the
          // dry-run preview, and the committed result's diff field. Scoped
          // calls see only their own slice; foreign staged files never
          // reach the LLM prompt or the preview.
          const { stat, diff: stagedDiff } = commitScope
            ? await getScopedStagedDiff(commitScope)
            : await getStagedDiff();

          // LLM generation from the staged diff (best-effort; needs a diff).
          let generatedByLlm = false;
          if (wantGenerate && staged.length > 0) {
            const g = await generateCommitFromDiff(api, stat, stagedDiff);
            if (g) {
              type = g.type;
              if (g.scope) scope = g.scope;
              summary = g.summary;
              if (g.body && !body) body = g.body;
              generatedByLlm = true;
            }
          }

          // Default the type when the caller (and the LLM) left it unset.
          if (!type) type = opts.defaultType as ConventionalType;

          // Validate the resolved type.
          const validTypes = [
            'feat',
            'fix',
            'docs',
            'style',
            'refactor',
            'test',
            'chore',
            'perf',
            'ci',
            'build',
            'revert',
          ];
          if (!type || !validTypes.includes(type)) {
            // For dryRun, preview a message anyway (smoke test uses empty input).
            if (dryRun) {
              return {
                ok: true,
                dry_run: true,
                message: `Would create: ${summary || 'update code'}`,
              };
            }
            return {
              ok: false,
              error: 'type is required and must be a valid conventional commit type',
            };
          }

          const msg = generateCommitMessage(type, scope, summary || 'update code', body);

          if (staged.length === 0) {
            return {
              ok: false,
              error:
                'Nothing staged. Pass files (exact paths) or paths (pathspec globs) to scope this commit, stage with git add beforehand, or set extensions["git-autocommit"].autoStage=true to allow staging every changed file (legacy whole-tree behavior).',
            };
          }

          // Scope-guard report: when other staged files exist OUTSIDE this
          // call's scope, say so explicitly. That content stays in the
          // index for whoever owns it instead of riding along silently.
          let scopeWarning: string | null = null;
          if (commitScope) {
            const scopedSet = new Set(commitScope);
            const foreign = staged.filter((f) => !scopedSet.has(f));
            if (foreign.length > 0) {
              const preview = foreign.slice(0, 10).join(', ');
              const suffix =
                foreign.length > 10 ? ` and ${foreign.length - 10} more` : '';
              scopeWarning =
                `⚠ Scope guard: ${foreign.length} staged file(s) outside the requested scope ` +
                `(${preview}${suffix}) were left uncommitted and remain staged for their owner.`;
            }
          }

          // Build warning before committing.
          const worktreeWarn = await simultaneousEditWarning();

          // Detect files modified by other agents since staging
          const externalChanges = await externalChangesSinceStage();
          let externalWarning: string | null = null;
          if (externalChanges && externalChanges.length > 0) {
            const preview = externalChanges.slice(0, 10).join(', ');
            const suffix =
              externalChanges.length > 10 ? ` and ${externalChanges.length - 10} more` : '';
            externalWarning =
              `⚠ External changes detected since staging: ${preview}${suffix}. ` +
              'Another agent may be modifying files concurrently. ' +
              'These unstaged changes will NOT be included in this commit, ' +
              'but they indicate simultaneous edits. Review carefully.';
          }

          const warning =
            [worktreeWarn, scopeWarning, externalWarning].filter(Boolean).join('\n') || undefined;

          // Return early in dry run with the diff visible
          if (dryRun) {
            return {
              ok: true,
              dry_run: true,
              message: `Would create: ${msg}`,
              warning: warning ?? undefined,
              stagedDiff: `\n## Staged changes (dry run)\n\n${stat}\n\n\`\`\`diff\n${stagedDiff}\n\`\`\``,
            };
          }

          // Scoped commits take working-tree content (`--only` semantics),
          // so verify the scoped paths still match what was staged and
          // previewed. An in-scope edit that landed since staging aborts the
          // commit — silently shipping it would betray the preview above.
          if (commitScope && !dryRun) {
            const drifted = await scopedPathsDrifted(commitScope);
            if (drifted.length > 0) {
              const preview = drifted.slice(0, 10).join(', ');
              const suffix = drifted.length > 10 ? ` and ${drifted.length - 10} more` : '';
              return {
                ok: false,
                error:
                  `Working tree changed after staging for: ${preview}${suffix}. ` +
                  'A scoped commit takes working-tree content, so committing now could include ' +
                  'changes that were never staged or previewed. Re-run the tool to re-stage the ' +
                  'current content.',
              };
            }
          }

          // Commit — fenced to the caller's scope when one exists.
          let hash = '';
          try {
            hash = await commitWithMessage(msg, undefined, commitScope);
          } catch (err: unknown) {
            /* v8 ignore next -- commitWithMessage only throws Error; the String(err) branch is defensive. */
            return {
              ok: false,
              error: `Failed to commit: ${err instanceof Error ? err.message : String(err)}`,
            };
          }

          api.log.info('git-autocommit: created commit', { hash, type, scope });

          // Bump the health counters only on success — a failed commit
          // must not show up in /diag plugins as having happened.
          commitCount.value += 1;
          if (generatedByLlm) llmGenerated.value += 1;
          lastCommit.hash = String(hash);
          lastCommit.at = new Date().toISOString();
          try {
            await api.session.append({
              type: 'git-autocommit:commit',
              ts: new Date().toISOString(),
              hash: String(hash),
              commitType: type,
              scope: String(scope ?? ''),
              /* v8 ignore next -- staged is always an array here; the : [] fallback is defensive. */
              files: Array.isArray(staged) ? (commitScope ?? staged) : [],
              warning: warning ?? null,
            });
          } catch (_err) {
            // Session append is best-effort; ignore errors
          }

          return {
            ok: true,
            hash,
            message: msg,
            stagedFiles: commitScope ?? staged,
            type,
            scope: scope ?? null,
            generatedByLlm,
            warning: warning ?? undefined,
            diff: `\n## Staged diff\n\n${stat}\n\n\`\`\`diff\n${stagedDiff}\n\`\`\``,
          };
          /* v8 ignore start -- top-level safety net: inner try/catches already handle the realistic failures. */
        } catch (err: unknown) {
          return {
            ok: false,
            error: `Uncaught error in git_autocommit: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
        /* v8 ignore stop */
      },
    });

    api.log.info('git-autocommit plugin loaded', {
      version: '0.3.0',
      conventionalCommits: opts.conventionalCommits,
    });
  },

  teardown(api) {
    // git-autocommit has no in-process resources to release (every
    // git interaction goes through the async `execFile` and finishes
    // before the tool returns), but we still want a symmetric teardown
    // so:
    //   1. /diag plugins can observe the unload
    //   2. The counters reset cleanly on the next setup() — without
    //      this, a reload that skips a successful commit would leave
    //      stale counts in health().
    // Snap the current values for the log line, then zero them so the
    // next setup() starts fresh (matching the cron/file-watcher
    // pattern from the H1 audit).
    const finalCount = commitCount.value;
    const finalHash = lastCommit.hash;
    const finalLlm = llmGenerated.value;
    commitCount.value = 0;
    llmGenerated.value = 0;
    lastCommit.hash = null;
    lastCommit.at = null;
    api.log.info('git-autocommit: teardown complete', {
      commits: finalCount,
      llmGenerated: finalLlm,
      lastHash: finalHash,
    });
  },

  async health() {
    // /diag plugins wants a quick yes/no plus a useful message.
    // `ok` reflects "did the plugin load successfully" — the plugin
    // is otherwise healthy until git itself is unreachable, which the
    // tool surface handles per-call. The message surfaces the last
    // commit so an operator can confirm the plugin is still wiring
    // commits at a glance.
    return {
      ok: true,
      message:
        commitCount.value === 0
          ? 'git-autocommit: no commits yet this session'
          : `git-autocommit: ${commitCount.value} commit(s) (${llmGenerated.value} LLM-written), last ${String(lastCommit.hash).slice(0, 8)} at ${lastCommit.at}`,
      commits: commitCount.value,
      llmGenerated: llmGenerated.value,
      lastCommitHash: lastCommit.hash,
      lastCommitAt: lastCommit.at,
    };
  },
};

export default plugin;
