import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { EventBus } from '../kernel/events.js';
import type { Plugin } from '../types/plugin.js';
import type { SlashCommand } from '../types/slash-command.js';
import { toErrorMessage } from '../utils/error.js';
import { readBundledInstructionText } from '../utils/instruction-file.js';
import { projectSlug } from '../utils/wstack-paths.js';
import {
  emitReviewIfChanged,
  recordCompletedReview,
  recordStartedReview,
} from './review-claim-registry.js';
import { buildReviewContext } from './review-context-builder.js';
import type {
  ResolvedChimeraConfig,
  ReviewContextBundle,
  ReviewFileEntry,
} from './review-types.js';
import { executeFindingCommand } from './review-finding-commands.js';
import { integrateFindings } from './review-finding-integration.js';
import { persistReviewReport } from './review-report-integration.js';

// Re-export the shared review types so existing importers keep resolving them
// from './chimera-plugin.js' (and the package barrel). Their definitions live
// in the leaf './review-types.js' module to keep the helper imports one-way.
export type {
  CascadeAgentKind,
  ChimeraCascadeNeededPayload,
  ChimeraReviewCompletePayload,
  ChimeraReviewNeededPayload,
  ResolvedChimeraConfig,
  ReviewContextBundle,
  ReviewFileEntry,
} from './review-types.js';

// ---------------------------------------------------------------------------
// Chimera configuration — read from config.extensions['wstack-chimera']
// ---------------------------------------------------------------------------
interface ChimeraConfig {
  enabled?: boolean | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  maxFiles?: number | undefined;
  /**
   * How to handle chimera review findings:
   * - `off` (default): Send result to mailbox; leader waits for user command.
   * - `ask`: Send ask to mailbox; leader prompts user for permission.
   * - `auto`: Spawn a fix subagent automatically with the review report.
   */
  autoFix?: 'off' | 'ask' | 'auto' | undefined;
  /**
   * Cascade severity threshold for follow-up agents. When the post-session
   * review finds findings at or above this level, security-scanner and/or
   * bug-hunter agents are spawned to investigate and fix. Mirrors the
   * auto-review plugin's cascadeOn. Default: "off" (no cascade).
   */
  cascadeOn?: 'off' | 'critical' | 'high' | undefined;
  /**
   * Maximum cascade fix→re-review cycles before the self-correcting loop
   * stops. Default: 2. 0 disables re-review (fix agents run once, no
   * re-check). Mirrors the auto-review plugin's maxCascadeDepth.
   */
  maxCascadeDepth?: number | undefined;
  /**
   * @deprecated Removed. The subagent's `Request.maxTokens` now defaults to
   * the provider's `capabilities.maxOutput`, so Chimera reports can run up
   * to the selected model's native ceiling. Kept on the config interface as an `unknown` sink
   * so old config files don't crash — but it's no longer read.
   */
  maxTokens?: unknown;
}

const DEFAULT_MAX_FILES = 15;
const DEFAULT_CASCADE_ON = 'off' as const;
const DEFAULT_MAX_CASCADE_DEPTH = 2;

export function resolveChimeraConfig(
  cfg: ChimeraConfig,
  sessionProvider: string,
  sessionModel: string,
): ResolvedChimeraConfig {
  return {
    enabled: cfg.enabled !== false,
    provider: cfg.provider ?? sessionProvider,
    model: cfg.model ?? sessionModel,
    maxFiles: cfg.maxFiles ?? DEFAULT_MAX_FILES,
    autoFix: cfg.autoFix ?? 'off',
    cascadeOn: cfg.cascadeOn ?? DEFAULT_CASCADE_ON,
    maxCascadeDepth: cfg.maxCascadeDepth ?? DEFAULT_MAX_CASCADE_DEPTH,
  };
}

// ---------------------------------------------------------------------------
// Event payload emitted on session.ended when chimera is enabled
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// System prompt for the subagent (matches packages/core/skills/chimera/SKILL.md)
// ---------------------------------------------------------------------------
export const CHIMERA_REVIEW_PROMPT = readBundledInstructionText('llm/chimera-review.md');

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------
async function runGit(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn('git', args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        signal: AbortSignal.timeout(15_000),
        windowsHide: true,
      });
    } catch (err) {
      // `spawn` throws synchronously when the binary is not found (e.g.,
      // git not installed on Windows). Reject the promise so callers can
      // handle it gracefully instead of surfacing as an unhandled rejection.
      reject(err);
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => { stdout += d; });
    child.stderr?.on('data', (d) => { stderr += d; });
    child.on('error', () => resolve({ stdout, stderr, code: 1 }));
    child.on('close', (code) => resolve({ stdout, stderr, code: code ?? 0 }));
  });
}

async function isGitRepo(cwd: string): Promise<boolean> {
  const r = await runGit(['rev-parse', '--git-dir'], cwd);
  return r.code === 0;
}

interface ChangedFile {
  path: string;
  status: 'added' | 'modified';
}

async function getChangedFiles(cwd: string): Promise<ChangedFile[]> {
  const r = await runGit(['status', '--porcelain'], cwd);
  if (r.code !== 0) return [];
  const files: ChangedFile[] = [];
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

// ---------------------------------------------------------------------------
// Slash command
// ---------------------------------------------------------------------------
function buildChimeraCommand(
  getConfig: () => ResolvedChimeraConfig,
  events: EventBus,
): SlashCommand {
  return {
    name: 'chimera',
    category: 'Session',
    description: 'Show Chimera post-session review agent status and configuration.',
    help: [
      '╔═══ Chimera ═══╗',
      '',
      'Post-session code quality guardian. Reviews files changed during',
      'each session using a dedicated read-only subagent.',
      '',
      'Commands:',
      '  /chimera          Show current status',
      '  /review           Manually review changed files now',
      '',
      'Configuration (edit config.json):',
      '  extensions.wstack-chimera.enabled    true | false',
      '  extensions.wstack-chimera.provider   provider id',
      '  extensions.wstack-chimera.model      model id',
      '  extensions.wstack-chimera.maxFiles   max files (default 15)',
      '  extensions.wstack-chimera.autoFix    off | ask | auto (default off)',
      '  extensions.wstack-chimera.cascadeOn  off | critical | high (default off)',
      '  extensions.wstack-chimera.maxCascadeDepth  max fix+re-review cycles (default 2)',
      '',
      'Output cap: the subagent runs up to the provider\'s model-native',
      'output ceiling (Anthropic 64K, OpenAI 16K, Gemini 8K). No manual cap.',
    ].join('\n'),
    async run(args) {
      const cfg = getConfig();
      const trimmed = (args ?? '').trim();

      // Subcommand: /chimera autoFix <off|ask|auto>
      if (trimmed.startsWith('autoFix') || trimmed.startsWith('autofix')) {
        const mode = trimmed.split(/\s+/)[1]?.toLowerCase();
        if (!mode || !['off', 'ask', 'auto'].includes(mode)) {
          return {
            message: [
              `Usage: /chimera autoFix <off|ask|auto>`,
              `Current: ${cfg.autoFix}`,
              '',
              '  off  — send review result to mailbox; leader waits for your command.',
              '  ask  — send review as an ask; leader prompts you for permission.',
              '  auto — send review result AND spawn a fix subagent automatically.',
            ].join('\n'),
          };
        }
        // Emit a custom event so the execution layer can update agent.ctx.meta in real time.
        (events as never as { emit: (name: string, payload: { mode: string }) => void }).emit('chimera.set_autofix', { mode });
        return {
          message: `✅ Chimera autoFix set to "${mode}" for this session (config file unchanged).`,
        };
      }

      return {
        message: [
          `🦂 Chimera — ${cfg.enabled ? 'enabled' : 'disabled'}`,
          '',
          `  Provider:   ${cfg.provider}`,
          `  Model:      ${cfg.model}`,
          `  Max files:  ${cfg.maxFiles}`,
          `  Auto-fix:   ${cfg.autoFix}`,
          `  Cascade:    ${cfg.cascadeOn === 'off' ? 'disabled' : `on ${cfg.cascadeOn}+ → spawns security-scanner/bug-hunter`}`,
          `  Max depth:  ${cfg.maxCascadeDepth} re-review cycle(s)`,
          `  Max output: model-native (no cap)`,
          '',
          cfg.enabled
            ? 'Auto-review runs after each session. /review triggers manually.'
            : 'Set extensions.wstack-chimera.enabled = true to enable.',
        ].join('\n'),
      };
    },
  };
}

// ── /review finding-store command ─────────────────────────────
function buildReviewCommand(
  _getConfig: () => ResolvedChimeraConfig,
): SlashCommand {
  return {
    name: 'review',
    category: 'Session',
    description: 'Query the Chimera Finding Store.',
    help: [
      'Usage: /review findings [--severity <s>] [--status <s>] [--limit <n>]',
      '       /review finding <id>',
      '       /review status',
      '',
      'The finding store persists structured findings from every Chimera review.',
      'Use this to track what issues were found, their lifecycle, and outcomes.',
    ].join('\n'),
    async run(args) {
      const cwd = process.cwd();
      const slug = projectSlug(cwd);
      const globalRoot = path.join(os.homedir(), '.wrongstack');
      const projectDir = path.join(globalRoot, 'projects', slug);
      const trimmed = (args ?? '').trim();
      const parts = trimmed.split(/\s+/).filter(Boolean);
      return {
        message: await executeFindingCommand(parts, { projectDir }),
      };
    },
  };
}

// ── Finding + report store persistence helper ────────────────
async function tryPersistFindings(payload: unknown): Promise<void> {
  if (!payload || typeof payload !== 'object') return;
  const p = payload as { bundle?: { cwd?: string }; reviewText?: string; status?: string; cwd?: string };
  const cwd = p.cwd ?? p.bundle?.cwd;
  if (!cwd) return;
  const slug = projectSlug(cwd);
  const globalRoot = path.join(os.homedir(), '.wrongstack');
  const projectDir = path.join(globalRoot, 'projects', slug);

  // One shared reportId links the finding store and the report store.
  const reportId = randomUUID();

  // Persist the report first (parent record), then findings (children).
  // If the process crashes between writes, an orphan report with no findings
  // is recoverable; orphan findings pointing at a nonexistent reportId are not.
  await persistReviewReport(payload as any, reportId, projectDir);
  await integrateFindings(payload as any, projectDir, reportId);
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------
export function createChimeraPlugin(): Plugin {
  return {
    name: 'wstack-chimera',
    version: '1.0.0',
    description: 'Post-session code quality guardian with subagent review.',
    apiVersion: '^0.1',
    capabilities: { slashCommands: true },
    defaultConfig: {},

    setup(api) {
      // ── Reactive config ──────────────────────────────────────────
      const recompute = (): ResolvedChimeraConfig => {
        const raw: ChimeraConfig =
          (api.config.extensions?.['wstack-chimera'] as ChimeraConfig | undefined) ?? {};
        return resolveChimeraConfig(raw, api.config.provider, api.config.model);
      };
      let resolved = recompute();

      api.onConfigChange(() => {
        const old = resolved;
        resolved = recompute();
        if (old.enabled !== resolved.enabled || old.provider !== resolved.provider || old.model !== resolved.model) {
          api.log.info(
            `[chimera] config changed — enabled=${resolved.enabled} provider=${resolved.provider} model=${resolved.model}`,
          );
        }
      });

      // Claim bookkeeping is cross-cutting session state, not Chimera feature
      // work. Keep it registered while disabled so config changes and reviews
      // emitted by other paths cannot leave stale in-flight claims behind.
      api.onPattern('chimera.review_needed', (_event, payload) => {
        recordStartedReview(api.events, payload);
      });
      api.onPattern('chimera.review_complete', (_event, payload) => {
        recordCompletedReview(api.events, payload);

        // FS-P0.6: Persist findings from the review into the finding store.
        // This runs even when chimera is disabled so findings from manual
        // reviews and other sessions are captured too.
        tryPersistFindings(payload).catch((err) => {
          api.log.warn(`[review-finding] failed to persist findings: ${toErrorMessage(err)}`);
        });
      });

      if (!resolved.enabled) {
        api.log.info('[chimera] disabled by config');
        return;
      }

      api.log.info(
        `[chimera] loaded — provider=${resolved.provider} model=${resolved.model} maxFiles=${resolved.maxFiles}`,
      );

      // ── /chimera command ──────────────────────────────────────────
      api.slashCommands.register(buildChimeraCommand(() => resolved, api.events));

      // ── /review command (finding store) ───────────────────────────
      api.slashCommands.register(buildReviewCommand(() => resolved));

      // ── session.ended → emit review event ─────────────────────────
      api.onEvent('session.ended', async () => {
        try {
        const cfg = resolved;
        if (!cfg.enabled) return;

        const cwd = api.config.cwd ?? process.cwd();
        if (!(await isGitRepo(cwd))) {
          api.log.info('[chimera] skipped — not a git repo');
          return;
        }

        const allChanged = await getChangedFiles(cwd);
        const existing: ChangedFile[] = [];
        for (const f of allChanged) {
          if (f.path.startsWith('.wrongstack/')) continue;
          try { await fsp.access(path.join(cwd, f.path)); existing.push(f); } catch { /* deleted */ }
        }

        if (existing.length === 0) {
          api.log.info('[chimera] no changed files to review');
          return;
        }

        const toReview = existing.slice(0, cfg.maxFiles);
        if (existing.length > cfg.maxFiles) {
          api.log.info(`[chimera] capping review at ${cfg.maxFiles} of ${existing.length} files`);
        }

        // Read file contents
        const filesWithContent: ReviewFileEntry[] = [];
        for (const f of toReview) {
          try {
            const absPath = path.join(cwd, f.path);
            const content = await fsp.readFile(absPath, 'utf8');
            filesWithContent.push({ path: f.path, status: f.status, content });
          } catch { /* skip */ }
        }

        if (filesWithContent.length === 0) {
          api.log.info('[chimera] could not read changed files');
          return;
        }

        // ── Build enriched review context (diffs, siblings, commits) ──
        const bundle: ReviewContextBundle = await buildReviewContext({
          cwd,
          config: cfg,
          files: filesWithContent,
          cascadeOn: cfg.cascadeOn,
          maxCascadeDepth: cfg.maxCascadeDepth,
        });

        // Atomically skip exact file content already claimed by a mid-session,
        // manual, or competing post-session review.
        const emittedBundle = emitReviewIfChanged(api, bundle);
        if (!emittedBundle) {
          api.log.info('[chimera] skipped — changed files already have reviews in progress');
          return;
        }

        api.log.info(`[chimera] emitted review_needed event (${emittedBundle.files.length} files)`);
        } catch (err) {
          api.log.warn(`[chimera] session.ended handler failed: ${toErrorMessage(err)}`);
        }
      });
    },

    teardown(api) {
      api.slashCommands.unregister('chimera');
      api.slashCommands.unregister('review');
      api.log.info('[chimera] unloaded');
    },

    async health() {
      return { ok: true, message: 'chimera ready' };
    },
  };
}
