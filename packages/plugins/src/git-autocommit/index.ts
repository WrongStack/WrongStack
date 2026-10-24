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

import { resolve } from 'node:path';
import { type Plugin, ToolValidationError } from '@wrongstack/contracts/types';
import { createHostStates } from '../runtime/host-state.js';
import type { ConventionalType } from './commit-message.js';
import { generateCommitFromDiff, generateCommitMessage } from './commit-message.js';
import {
  commitWithMessage,
  externalChangesSinceStage,
  getChangedFiles,
  getScopedStagedDiff,
  getScopedStagedFiles,
  getStagedDiff,
  getStagedFiles,
  scopedPathsDrifted,
  simultaneousEditWarning,
  stageFiles,
} from './git-operations.js';

const API_VERSION = '^0.1.10';

const hosts = createHostStates(() => ({
  abort: new AbortController(),
  extensionUnregister: null as (() => void) | null,
  commitCount: { value: 0 },
  llmGenerated: { value: 0 },
  lastCommit: { hash: null as string | null, at: null as string | null },
}));

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
    const state = hosts.reset(api);
    const { commitCount, llmGenerated, lastCommit } = state;

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
      async execute(input: Record<string, unknown>, ctx, execution) {
        const cwd = resolve(ctx?.projectRoot ?? ctx?.cwd ?? api.config.cwd ?? process.cwd());
        const signal = AbortSignal.any([
          state.abort.signal,
          ...(execution?.signal ? [execution.signal] : []),
        ]);
        signal.throwIfAborted();
        try {
          let type = input['type'] as ConventionalType | undefined;
          let scope = input['scope'] as string | undefined;
          let summary =
            ((input['message'] ?? input['summary'] ?? input['msg'] ?? input['description']) as
              | string
              | undefined) ?? '';
          let body = input['body'] as string | undefined;
          const dryRun = input['dry_run'] ?? (input['dryRun'] as boolean) ?? false;

          // LLM message generation is opt-in and only runs when the host
          // wired `api.llm`: an explicit `generate: true`, or the `useLlm`
          // config flag when the caller supplied neither type nor message.
          const explicitAsk =
            (input['generate'] ?? input['autoGenerate'] ?? input['auto_generate']) === true;
          const autoAsk =
            opts.useLlm && !input['type'] && !(input['message'] as string | undefined);
          const wantGenerate = (explicitAsk || autoAsk) && Boolean(api.llm);

          // Validate files input shape early.
          let files: string[] | undefined;
          const rawFiles = input['files'] ?? input['fileList'] ?? input['file_list'];
          if (rawFiles !== undefined) {
            if (!Array.isArray(rawFiles)) {
              throw new ToolValidationError({
                message: 'files must be an array of file paths',
                field: 'files',
              });
            }
            files = rawFiles;
          } else if (
            typeof (input['file'] ?? input['file_path']) === 'string' &&
            String(input['file'] ?? input['file_path']).trim().length > 0
          ) {
            files = [String(input['file'] ?? input['file_path']).trim()];
          } else if (typeof input['filePath'] === 'string' && input['filePath'].trim().length > 0) {
            files = [input['filePath'].trim()];
          } else if (
            typeof (input['TargetFile'] ?? input['targetFile']) === 'string' &&
            String(input['TargetFile'] ?? input['targetFile']).trim().length > 0
          ) {
            files = [String(input['TargetFile'] ?? input['targetFile']).trim()];
          }

          // Validate paths input shape early.
          let pathspecs: string[] | undefined;
          const rawPaths = input['paths'] ?? input['pathList'] ?? input['path_list'];
          if (rawPaths !== undefined) {
            if (!Array.isArray(rawPaths)) {
              throw new ToolValidationError({
                message: 'paths must be an array of pathspec patterns',
                field: 'paths',
              });
            }
            pathspecs = rawPaths.filter((p): p is string => typeof p === 'string' && p.length > 0);
            if (pathspecs.length === 0) {
              throw new ToolValidationError({
                message: 'paths must contain at least one non-empty pattern',
                field: 'paths',
              });
            }
          } else if (typeof input['path'] === 'string' && input['path'].trim().length > 0) {
            pathspecs = [input['path'].trim()];
          }

          // Reject the combination rather than silently dropping one side:
          if (rawPaths !== undefined && files && files.length > 0) {
            throw new ToolValidationError({
              message:
                'Pass either files (exact paths) or paths (pathspec globs), not both — the other would be silently ignored.',
              field: 'paths',
            });
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
              await stageFiles(pathspecs, cwd, signal);
            } catch (err: unknown) {
              throw new Error(
                `Failed to stage files matching paths: ${err instanceof Error ? err.message : String(err)}`,
                { cause: err },
              );
            }
            try {
              staged = await getScopedStagedFiles(pathspecs, cwd, signal);
            } catch {
              staged = [];
            }
            if (staged.length === 0) {
              throw new Error(
                'No changed files match the given paths — refusing to commit anything else.',
              );
            }
            commitScope = staged;
            // Read the FULL index for the scope-guard warning below. The
            // scoped readback alone would hide foreign staged files, making
            // the warning permanently empty on this flow.
            try {
              staged = await getStagedFiles(cwd, signal);
            } catch {
              staged = commitScope;
            }
          } else if (files && files.length > 0) {
            // Exact-files flow: stage them; the commit below is fenced to the
            // concrete paths git actually staged, not the raw caller list — a
            // non-existent path is filtered by stageFiles and must not reach
            // `git commit --only` (which would abort the whole commit).
            try {
              commitScope = await stageFiles(files, cwd, signal);
            } catch (err: unknown) {
              /* v8 ignore next -- stageFiles only throws Error; the String(err) branch is defensive. */
              const detail = err instanceof Error ? err.message : String(err);
              // stageFiles already phrases its own refusals this way; wrapping
              // them again printed "Failed to stage files: Failed to stage files: …".
              throw new Error(
                detail.startsWith('Failed to stage files')
                  ? detail
                  : `Failed to stage files: ${detail}`,
                { cause: err },
              );
            }
            try {
              staged = await getStagedFiles(cwd, signal);
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
              staged = await getStagedFiles(cwd, signal);
            } catch {
              staged = [];
            }
            if (staged.length === 0 && opts.autoStage) {
              try {
                const changed = await getChangedFiles(cwd, signal);
                if (changed.length > 0) {
                  try {
                    await stageFiles(changed, cwd, signal);
                  } catch {
                    /* ignore staging errors */
                  }
                  try {
                    staged = await getStagedFiles(cwd, signal);
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
            ? await getScopedStagedDiff(commitScope, cwd, signal)
            : await getStagedDiff(cwd, signal);

          signal.throwIfAborted();

          // LLM generation from the staged diff (best-effort; needs a diff).
          let generatedByLlm = false;
          if (wantGenerate && staged.length > 0) {
            const g = await generateCommitFromDiff(api, stat, stagedDiff, signal);
            if (g) {
              type = g.type;
              if (g.scope) scope = g.scope;
              summary = g.summary;
              if (g.body && !body) body = g.body;
              generatedByLlm = true;
            }
          }

          signal.throwIfAborted();

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
            throw new ToolValidationError({
              message: 'type is required and must be a valid conventional commit type',
              field: 'type',
            });
          }

          const msg = generateCommitMessage(type, scope, summary || 'update code', body);

          if (staged.length === 0) {
            throw new Error(
              'Nothing staged. Pass files (exact paths) or paths (pathspec globs) to scope this commit, stage with git add beforehand, or set extensions["git-autocommit"].autoStage=true to allow staging every changed file (legacy whole-tree behavior).',
            );
          }

          // Scope-guard report: when other staged files exist OUTSIDE this
          // call's scope, say so explicitly. That content stays in the
          // index for whoever owns it instead of riding along silently.
          let scopeWarning: string | null = null;
          if (commitScope) {
            // Compare against the index paths the scope COVERS: a directory in
            // `files` stages (and `commit --only` commits) everything under
            // it, so its literal entry never equals `src/a.ts` and the
            // caller's own files were reported as foreign and "left
            // uncommitted".
            let covered: string[] = [];
            try {
              covered = await getScopedStagedFiles(commitScope, cwd, signal);
            } catch {
              covered = [];
            }
            const scopedSet = new Set([...commitScope, ...covered]);
            const foreign = staged.filter((f) => !scopedSet.has(f));
            if (foreign.length > 0) {
              const preview = foreign.slice(0, 10).join(', ');
              const suffix = foreign.length > 10 ? ` and ${foreign.length - 10} more` : '';
              scopeWarning =
                `⚠ Scope guard: ${foreign.length} staged file(s) outside the requested scope ` +
                `(${preview}${suffix}) were left uncommitted and remain staged for their owner.`;
            }
          }

          // Build warning before committing.
          const worktreeWarn = await simultaneousEditWarning(cwd, signal);

          // Detect files modified by other agents since staging
          const externalChanges = await externalChangesSinceStage(cwd, signal);
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

          signal.throwIfAborted();

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
            const drifted = await scopedPathsDrifted(commitScope, cwd, signal);
            if (drifted.length > 0) {
              const preview = drifted.slice(0, 10).join(', ');
              const suffix = drifted.length > 10 ? ` and ${drifted.length - 10} more` : '';
              throw new Error(
                `Working tree changed after staging for: ${preview}${suffix}. ` +
                  'A scoped commit takes working-tree content, so committing now could include ' +
                  'changes that were never staged or previewed. Re-run the tool to re-stage the ' +
                  'current content.',
              );
            }
          }

          // Commit — fenced to the caller's scope when one exists.
          let hash = '';
          try {
            hash = await commitWithMessage(msg, cwd, commitScope, signal);
          } catch (err: unknown) {
            /* v8 ignore next -- commitWithMessage only throws Error; the String(err) branch is defensive. */
            throw new Error(
              `Failed to commit: ${err instanceof Error ? err.message : String(err)}`,
              { cause: err },
            );
          }

          api.log.info('git-autocommit: created commit', { hash, type, scope });

          // Bump the health counters only on success — a failed commit
          // must not show up in /diag plugins as having happened.
          commitCount.value += 1;
          if (generatedByLlm) llmGenerated.value += 1;
          lastCommit.hash = String(hash);
          lastCommit.at = new Date().toISOString();
          try {
            await api.session?.append?.({
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
          // Deliberate failures above already carry a clear message; only
          // wrap non-Error throwables.
          if (err instanceof Error) throw err;
          throw new Error(`Uncaught error in git_autocommit: ${String(err)}`, { cause: err });
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
    const state = hosts.remove(api);
    if (!state) return;
    const { commitCount, llmGenerated, lastCommit } = state;
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
    const active = [...hosts.values()];
    const commitCount = { value: active.reduce((sum, host) => sum + host.commitCount.value, 0) };
    const llmGenerated = { value: active.reduce((sum, host) => sum + host.llmGenerated.value, 0) };
    const lastCommit = active
      .map((host) => host.lastCommit)
      .sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))[0] ?? { hash: null, at: null };
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
export { parsePorcelainLine } from './git-operations.js';
