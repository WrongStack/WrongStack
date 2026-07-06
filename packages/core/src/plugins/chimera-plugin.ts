import { spawn } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { Plugin } from '../types/plugin.js';
import type { SlashCommand } from '../types/slash-command.js';
import { toErrorMessage } from '../utils/error.js';
import { readBundledInstructionText } from '../utils/instruction-file.js';

// ---------------------------------------------------------------------------
// Chimera configuration — read from config.extensions['wstack-chimera']
// ---------------------------------------------------------------------------
interface ChimeraConfig {
  enabled?: boolean | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  maxFiles?: number | undefined;
  /**
   * @deprecated Removed. The subagent's `Request.maxTokens` now defaults to
   * the provider's `capabilities.maxOutput`, so Chimera reports can run up
   * to the selected model's native ceiling. Kept on the config interface as an `unknown` sink
   * so old config files don't crash — but it's no longer read.
   */
  maxTokens?: unknown;
}

export interface ResolvedChimeraConfig {
  enabled: boolean;
  provider: string;
  model: string;
  maxFiles: number;
}

const DEFAULT_MAX_FILES = 15;

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
  };
}

// ---------------------------------------------------------------------------
// Event payload emitted on session.ended when chimera is enabled
// ---------------------------------------------------------------------------
export interface ChimeraReviewNeededPayload {
  /** Resolved chimera config */
  config: ResolvedChimeraConfig;
  /** Project root for git operations */
  cwd: string;
  /** Changed files with their contents */
  files: Array<{ path: string; status: 'added' | 'modified'; content: string }>;
}

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
function buildChimeraCommand(getConfig: () => ResolvedChimeraConfig): SlashCommand {
  return {
    name: 'chimera',
    category: 'Session',
    description: 'Show Chimera post-session review agent status and configuration.',
    help: [
      '╔═══ Chimera ═══╗',
      '',
      'Post-session code quality guardian. Reviews files changed during',
      'each session using a dedicated subagent with full tool access.',
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
      '',
      'Output cap: the subagent runs up to the provider\'s model-native',
      'output ceiling (Anthropic 64K, OpenAI 16K, Gemini 8K). No manual cap.',
    ].join('\n'),
    async run() {
      const cfg = getConfig();
      return {
        message: [
          `🦂 Chimera — ${cfg.enabled ? 'enabled' : 'disabled'}`,
          '',
          `  Provider:  ${cfg.provider}`,
          `  Model:     ${cfg.model}`,
          `  Max files: ${cfg.maxFiles}`,
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

      if (!resolved.enabled) {
        api.log.info('[chimera] disabled by config');
        return;
      }

      api.log.info(
        `[chimera] loaded — provider=${resolved.provider} model=${resolved.model} maxFiles=${resolved.maxFiles}`,
      );

      // ── /chimera command ──────────────────────────────────────────
      api.slashCommands.register(buildChimeraCommand(() => resolved));

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
        const filesWithContent: ChimeraReviewNeededPayload['files'] = [];
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

        // Emit custom event — execution.ts picks this up and spawns the subagent
        api.emitCustom('chimera.review_needed', {
          config: cfg,
          cwd,
          files: filesWithContent,
        } satisfies ChimeraReviewNeededPayload);

        api.log.info(`[chimera] emitted review_needed event (${filesWithContent.length} files)`);
        } catch (err) {
          api.log.warn(`[chimera] session.ended handler failed: ${toErrorMessage(err)}`);
        }
      });
    },

    teardown(api) {
      api.slashCommands.unregister('chimera');
      api.log.info('[chimera] unloaded');
    },

    async health() {
      return { ok: true, message: 'chimera ready' };
    },
  };
}
