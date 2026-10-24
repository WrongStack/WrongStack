/**
 * pr-drafter plugin — collects work done during a session and drafts a
 * pull-request description.
 *
 * As the session runs, the plugin listens to:
 *  - `tool.completed` events for `git_autocommit` (records commit messages)
 *  - `tool.completed` events for `write`/`edit` (records changed files)
 *  - `provider.response` events (records model usage)
 *
 * On `Stop` it composes a markdown PR body and writes it to a configurable
 * file (default: `.wrongstack/PR_DRAFT.md`). A `pr_draft` tool lets the
 * agent request the draft on demand.
 *
 * Config (`config.extensions['pr-drafter']`):
 *
 * ```jsonc
 * {
 *   "enabled": true,
 *   "outputPath": ".wrongstack/PR_DRAFT.md",
 *   "writeOnStop": true,
 *   "includeDiff": true,
 *   "includeCommits": true,
 *   "includeFiles": true,
 *   "aiSummary": false
 * }
 * ```
 *
 * @public
 */

import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { type Plugin, type PluginAPI, ToolValidationError } from '@wrongstack/contracts/types';
import { gitIsolationEnv } from '@wrongstack/primitives';
import { releaseHandle } from '../runtime/index.js';

const API_VERSION = '^0.1.10';

// ---------------------------------------------------------------------------
// Module-scope state (H1 audit pattern)
// ---------------------------------------------------------------------------

interface PrDrafterState {
  commits: string[];
  files: Set<string>;
  models: Set<string>;
  totalInputTokens: number;
  totalOutputTokens: number;
  toolCalls: number;
  draftsWritten: number;
  draftErrors: number;
  stopInvocations: number;
  stopHookUnregister: null | (() => void);
  postHookUnregister: null | (() => void);
  eventUnsubscribers: Array<() => void>;
}

const state: PrDrafterState = {
  commits: [],
  files: new Set(),
  models: new Set(),
  totalInputTokens: 0,
  totalOutputTokens: 0,
  toolCalls: 0,
  draftsWritten: 0,
  draftErrors: 0,
  stopInvocations: 0,
  stopHookUnregister: null,
  postHookUnregister: null,
  eventUnsubscribers: [],
};

const TRACKED_FILE_TOOLS = new Set(['write', 'edit', 'write_to_file', 'replace_file_content']);

/**
 * Extract the commit from git_autocommit's serialized result (`{ok, hash, message, …, diff}`).
 * Regex, not JSON.parse: the trailing diff can push the text past the output budget and
 * truncate it. A dry run carries no `hash`, so it records nothing.
 */
export function parseAutocommitResult(content: string): { hash: string; message: string } | null {
  const hash = /"hash":\s*"([0-9a-f]{7,64})"/.exec(content)?.[1];
  if (!hash) return null;
  const rawMessage = /"message":\s*("(?:[^"\\]|\\.)*")/.exec(content)?.[1];
  let message = 'commit';
  if (rawMessage) {
    try {
      message = JSON.parse(rawMessage) as string;
    } catch {
      // keep the fallback label
    }
  }
  return { hash, message };
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface PrDrafterConfig {
  enabled: boolean;
  outputPath: string;
  writeOnStop: boolean;
  includeDiff: boolean;
  includeCommits: boolean;
  includeFiles: boolean;
  aiSummary: boolean;
}

const DEFAULTS: PrDrafterConfig = {
  enabled: true,
  outputPath: '.wrongstack/PR_DRAFT.md',
  writeOnStop: true,
  includeDiff: true,
  includeCommits: true,
  includeFiles: true,
  aiSummary: false,
};

function readConfig(raw: unknown): PrDrafterConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  return {
    enabled: r['enabled'] !== false,
    outputPath: typeof r['outputPath'] === 'string' ? r['outputPath'] : DEFAULTS.outputPath,
    writeOnStop: r['writeOnStop'] !== false,
    includeDiff: r['includeDiff'] !== false,
    includeCommits: r['includeCommits'] !== false,
    includeFiles: r['includeFiles'] !== false,
    aiSummary: r['aiSummary'] === true,
  };
}

function resolveProjectPath(rawPath: string, cwd = process.cwd()): string | null {
  if (typeof rawPath !== 'string' || rawPath.length === 0) return null;
  const root = resolve(cwd);
  const resolved = isAbsolute(rawPath) ? resolve(rawPath) : resolve(root, rawPath);
  const rel = relative(root, resolved);
  if (rel === '' || (rel.split(/[\\/]/)[0] !== '..' && !isAbsolute(rel))) return resolved;
  return null;
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

async function runGit(args: string[], timeout: number): Promise<string | null> {
  // The repository's config names programs git runs on status/diff
  // (fsmonitor, `.gitattributes` filters); when they cannot be switched off,
  // git does not run.
  const isolation = await gitIsolationEnv(process.cwd(), { timeoutMs: timeout });
  if (!isolation) return null;
  return new Promise((resolveOutput) => {
    execFile(
      'git',
      args,
      {
        encoding: 'utf8',
        cwd: process.cwd(),
        env: { ...process.env, ...isolation },
        windowsHide: true,
        timeout,
        maxBuffer: 5 * 1024 * 1024,
      },
      (error, stdout) => resolveOutput(error ? null : stdout.trim()),
    );
  });
}

function gitBranch(): Promise<string | null> {
  return runGit(['rev-parse', '--abbrev-ref', 'HEAD'], 5000);
}

function gitDiff(): Promise<string | null> {
  return runGit(['diff', '--stat'], 10_000);
}

// ---------------------------------------------------------------------------
// Draft builder
// ---------------------------------------------------------------------------

async function buildDraft(
  cfg: PrDrafterConfig,
  llm: PluginAPI['llm'],
): Promise<{ title: string; body: string }> {
  const [branch, diffStat] = await Promise.all([
    gitBranch(),
    cfg.includeDiff ? gitDiff() : Promise.resolve(null),
  ]);

  const lines: string[] = [];
  lines.push('# PR Draft');
  if (branch) lines.push(`**Branch:** \`${branch}\``);
  lines.push(`**Generated:** ${new Date().toISOString()}`);
  lines.push('');

  if (cfg.aiSummary && llm) {
    try {
      const context =
        `Files changed: ${[...state.files].join(', ') || 'none'}\n` +
        `Commits: ${state.commits.join('; ') || 'none'}\n` +
        `Tool calls: ${state.toolCalls}\n` +
        `Tokens: ${state.totalInputTokens} in / ${state.totalOutputTokens} out`;
      const result = await llm.complete(
        'Write a concise PR title and one-paragraph summary for the changes below. ' +
          'Format exactly as:\nTITLE: <title>\nSUMMARY: <summary>\n\n' +
          context,
        {
          system: 'You write terse engineering PR descriptions.',
          role: 'document',
        },
      );
      const text = result.text.trim();
      const titleMatch = /TITLE:\s*(.+)/i.exec(text);
      const summaryMatch = /SUMMARY:\s*(.+)/is.exec(text);
      if (titleMatch?.[1]) lines.push(`## ${titleMatch[1].trim()}`);
      if (summaryMatch?.[1]) lines.push(summaryMatch[1].trim(), '');
    } catch {
      // ignore AI failures
    }
  }

  if (cfg.includeCommits && state.commits.length > 0) {
    lines.push('## Commits');
    for (const c of state.commits) lines.push(`- ${c}`);
    lines.push('');
  }

  if (cfg.includeFiles && state.files.size > 0) {
    lines.push('## Files changed');
    for (const f of [...state.files].sort()) lines.push(`- \`${f}\``);
    lines.push('');
  }

  if (diffStat) {
    lines.push('## Diff summary');
    lines.push('```');
    lines.push(diffStat);
    lines.push('```');
    lines.push('');
  }

  lines.push('## Session metrics');
  lines.push(`- Tool calls: ${state.toolCalls}`);
  lines.push(`- Models used: ${[...state.models].join(', ') || 'unknown'}`);
  lines.push(`- Tokens: ${state.totalInputTokens} in / ${state.totalOutputTokens} out`);
  lines.push('');

  const title = state.commits[0] ?? `Changes on ${branch ?? 'current branch'}`;
  return { title, body: lines.join('\n') };
}

async function writeDraft(cfg: PrDrafterConfig, llm: PluginAPI['llm']): Promise<void> {
  const resolved = resolveProjectPath(cfg.outputPath);
  if (!resolved) {
    state.draftErrors += 1;
    return;
  }
  const draft = await buildDraft(cfg, llm);
  try {
    await mkdir(dirname(resolved), { recursive: true });
    await writeFile(resolved, draft.body);
    state.draftsWritten += 1;
  } catch {
    state.draftErrors += 1;
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: 'pr-drafter',
  version: '0.1.0',
  description:
    'Collects session work (commits, edited files, diff) and drafts a pull-request description',
  apiVersion: API_VERSION,
  capabilities: { tools: true, hooks: true, llm: true },
  defaultConfig: { ...DEFAULTS },
  configSchema: {
    type: 'object',
    properties: {
      enabled: { type: 'boolean', default: true, description: 'Master switch.' },
      outputPath: {
        type: 'string',
        default: '.wrongstack/PR_DRAFT.md',
        description: 'Path where the markdown PR draft is written.',
      },
      writeOnStop: {
        type: 'boolean',
        default: true,
        description: 'Automatically write the draft when the session stops.',
      },
      includeDiff: {
        type: 'boolean',
        default: true,
        description: 'Include git diff --stat in the draft.',
      },
      includeCommits: {
        type: 'boolean',
        default: true,
        description: 'Include recorded commit messages.',
      },
      includeFiles: {
        type: 'boolean',
        default: true,
        description: 'Include files touched by write/edit tools.',
      },
      aiSummary: {
        type: 'boolean',
        default: false,
        description: 'Use api.llm to generate a PR title and summary.',
      },
      llm: {
        type: 'object',
        description: 'Optional { provider, model } override for the AI summary.',
      },
    },
  },

  setup(api) {
    // Idempotent re-init (H1 audit pattern).
    state.commits = [];
    state.files = new Set();
    state.models = new Set();
    state.totalInputTokens = 0;
    state.totalOutputTokens = 0;
    state.toolCalls = 0;
    state.draftsWritten = 0;
    state.draftErrors = 0;
    state.stopInvocations = 0;
    state.stopHookUnregister = releaseHandle(state.stopHookUnregister);
    state.postHookUnregister = releaseHandle(state.postHookUnregister);
    for (const off of state.eventUnsubscribers) {
      try {
        off();
      } catch {
        // best-effort
      }
    }
    state.eventUnsubscribers = [];

    const cfg = readConfig(api.config.extensions?.['pr-drafter']);

    // `tool.completed` carries only {name, id, durationMs, outputChars} — no input or
    // result — and fires for successful calls only, so it is used purely as a counter.
    if (api.onPattern) {
      const offTool = api.onPattern('tool.completed', () => {
        state.toolCalls += 1;
      });
      state.eventUnsubscribers.push(offTool);
    }

    // Commits and edited files come from PostToolUse, the one surface with the tool's
    // input and result. The old listener read `p.tool` / `p.input` / `p.result.committed`
    // off `tool.completed`, none of which exist, so it recorded nothing.
    const postHook = (input: {
      toolName?: string | undefined;
      toolInput?: unknown;
      toolResult?: { content: string; isError: boolean } | undefined;
    }): void => {
      // git_autocommit throws on refusal/failure; never record a failed call.
      if (!input.toolResult || input.toolResult.isError) return;
      const toolName = input.toolName;

      if (toolName === 'git_autocommit') {
        const commit = parseAutocommitResult(String(input.toolResult.content ?? ''));
        // The message carries the LLM-written body after a blank line; a PR
        // title and a bullet list take the subject only.
        if (commit) state.commits.push(commit.message.split(/\r?\n/, 1)[0]!.trim() || 'commit');
        return;
      }

      if (!toolName || !TRACKED_FILE_TOOLS.has(toolName)) return;
      const rawInput = (input.toolInput ?? {}) as Record<string, unknown>;
      const filePath = ['path', 'filePath', 'file_path', 'TargetFile', 'targetFile', 'file']
        .map((key) => rawInput[key])
        .find((value): value is string => typeof value === 'string' && value.length > 0);
      if (filePath) state.files.add(filePath);
    };

    if (api.onEvent) {
      const offUsage = api.onEvent('provider.response', (payload: unknown) => {
        const p = payload as {
          model?: string;
          usage?: { input?: number; output?: number };
        } | null;
        if (p?.model) state.models.add(p.model);
        const rawUsage = p?.usage as Record<string, unknown> | undefined;
        const rawInput =
          (typeof rawUsage?.['input'] === 'number' ? rawUsage['input'] : undefined) ??
          (typeof rawUsage?.['prompt_tokens'] === 'number'
            ? rawUsage['prompt_tokens']
            : undefined) ??
          (typeof rawUsage?.['input_tokens'] === 'number' ? rawUsage['input_tokens'] : undefined) ??
          (typeof rawUsage?.['promptTokens'] === 'number' ? rawUsage['promptTokens'] : 0);
        const rawOutput =
          (typeof rawUsage?.['output'] === 'number' ? rawUsage['output'] : undefined) ??
          (typeof rawUsage?.['completion_tokens'] === 'number'
            ? rawUsage['completion_tokens']
            : undefined) ??
          (typeof rawUsage?.['output_tokens'] === 'number'
            ? rawUsage['output_tokens']
            : undefined) ??
          (typeof rawUsage?.['completionTokens'] === 'number' ? rawUsage['completionTokens'] : 0);
        // A non-finite provider usage value (JSON `1e999` parses to Infinity,
        // an upstream proxy may emit NaN) would poison the cumulative totals
        // and any later arithmetic against them. Normalize at the boundary,
        // matching the invariant already applied in token-budget and
        // token-throttle.
        const inputTokens = Number.isFinite(rawInput) ? rawInput : 0;
        const outputTokens = Number.isFinite(rawOutput) ? rawOutput : 0;
        state.totalInputTokens += inputTokens;
        state.totalOutputTokens += outputTokens;
      });
      state.eventUnsubscribers.push(offUsage);

      // The draft describes "this session's work", but the plugin is set up
      // once per PROCESS and the host outlives any one session (the WebUI
      // opens additional sessions in the same process). Nothing cleared the
      // collected commits, files, models or token totals, so a draft written
      // in the second session silently included the first session's work.
      const offSession = api.onEvent('session.ended', () => {
        state.commits = [];
        state.files = new Set();
        state.models = new Set();
        state.totalInputTokens = 0;
        state.totalOutputTokens = 0;
        state.toolCalls = 0;
      });
      state.eventUnsubscribers.push(offSession);
    }

    // Stop hook.
    const stopHook = async (): Promise<void> => {
      if (!cfg.enabled || !cfg.writeOnStop) return;
      state.stopInvocations += 1;
      await writeDraft(cfg, api.llm);
    };
    state.stopHookUnregister = api.registerHook('Stop', undefined, stopHook as never);
    state.postHookUnregister = api.registerHook(
      'PostToolUse',
      'git_autocommit|write|edit|write_to_file|replace_file_content',
      postHook as never,
    );

    // --- pr_draft tool ---
    api.tools.register({
      name: 'pr_draft',
      description:
        'Generate or refresh the pull-request draft for the current session. Writes the markdown file and returns its path + title.',
      inputSchema: {
        type: 'object',
        properties: {
          preview: {
            type: 'boolean',
            description: 'When true, return the draft body without writing to disk.',
          },
        },
      },
      // Writes the draft to disk (`writeFile` below), so `mutating: false` was
      // not just a missing capability — it actively LIED, letting even a gate
      // that reads `mutating` correctly through. It also flipped the tool onto
      // the wrong side of `smoke.test.ts`, which skips `mutating: true` tools:
      // this one was exercised by the suite and wrote to the repo during it.
      permission: 'confirm',
      category: 'Workflow',
      mutating: true,
      capabilities: ['fs.write'],
      async execute(input: { preview?: boolean | undefined } = {}) {
        // Failures throw: the executor only flags a call as failed when execute rejects.
        if (!cfg.enabled) throw new Error('pr-drafter is disabled');
        const raw = (input ?? {}) as Record<string, unknown>;
        const preview = Boolean(
          input?.preview ?? raw['dryRun'] ?? raw['dry_run'] ?? raw['dry'] ?? raw['previewOnly'],
        );
        const rawOutputPath =
          raw['outputPath'] ??
          raw['output_path'] ??
          raw['path'] ??
          raw['filePath'] ??
          raw['file'] ??
          raw['TargetFile'] ??
          raw['targetFile'] ??
          cfg.outputPath;
        const outputPathStr =
          typeof rawOutputPath === 'string' && rawOutputPath.trim().length > 0
            ? rawOutputPath.trim()
            : cfg.outputPath;
        const draft = await buildDraft(cfg, api.llm);
        if (preview) {
          return { ok: true, preview: true, title: draft.title, body: draft.body };
        }
        const resolved = resolveProjectPath(outputPathStr);
        if (!resolved) {
          throw new ToolValidationError({
            message: 'outputPath resolves outside project',
            field: 'outputPath',
          });
        }
        try {
          await mkdir(dirname(resolved), { recursive: true });
          await writeFile(resolved, draft.body);
        } catch (err) {
          state.draftErrors += 1;
          throw new Error(
            `Could not write PR draft to ${outputPathStr}: ${err instanceof Error ? err.message : String(err)}`,
            { cause: err },
          );
        }
        state.draftsWritten += 1;
        return {
          ok: true,
          path: outputPathStr,
          resolvedPath: resolved,
          title: draft.title,
        };
      },
    });

    api.log.info('pr-drafter plugin loaded', {
      version: '0.1.0',
      outputPath: cfg.outputPath,
      writeOnStop: cfg.writeOnStop,
    });
  },

  teardown(api) {
    if (state.stopHookUnregister) {
      try {
        state.stopHookUnregister();
      } catch {
        // best-effort
      }
      state.stopHookUnregister = null;
    }
    state.postHookUnregister = releaseHandle(state.postHookUnregister);
    for (const off of state.eventUnsubscribers) {
      try {
        off();
      } catch {
        // best-effort
      }
    }
    state.eventUnsubscribers = [];
    const final = {
      commits: state.commits.length,
      files: state.files.size,
      toolCalls: state.toolCalls,
      draftsWritten: state.draftsWritten,
      draftErrors: state.draftErrors,
    };
    state.commits = [];
    state.files = new Set();
    state.models = new Set();
    state.totalInputTokens = 0;
    state.totalOutputTokens = 0;
    state.toolCalls = 0;
    state.draftsWritten = 0;
    state.draftErrors = 0;
    state.stopInvocations = 0;
    api.log.info('pr-drafter: teardown complete', { final });
  },

  async health() {
    return {
      ok: state.draftErrors === 0,
      message: `pr-drafter: ${state.commits.length} commit(s), ${state.files.size} file(s), ${state.draftsWritten} draft(s) written, ${state.draftErrors} error(s)`,
      counters: {
        commits: state.commits.length,
        files: state.files.size,
        toolCalls: state.toolCalls,
        draftsWritten: state.draftsWritten,
        draftErrors: state.draftErrors,
        totalInputTokens: state.totalInputTokens,
        totalOutputTokens: state.totalOutputTokens,
      },
    };
  },
};

export default plugin;
