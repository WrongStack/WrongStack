/** Session/runtime slash-command adapters for the CLI command host. */
import { spawn } from 'node:child_process';
import type { Context } from '@wrongstack/core/agent';
import { allServers } from '@wrongstack/core/infrastructure';
import type { EventBus } from '@wrongstack/core/kernel';
import type { ToolRegistry } from '@wrongstack/core/registry';
import type { Config, ConfigStore, TokenCounter } from '@wrongstack/core/types';
import { color, writeOut } from '@wrongstack/core/utils';
import type { MCPRegistry } from '@wrongstack/mcp';
import type { MultiAgentHost } from '../multi-agent.js';
import { runPluginManagementCommand } from '../plugin-management.js';
import type { CommitLLMProvider } from '../services/commit-message.js';
import { generateCommitMessageWithLLM } from '../services/commit-message.js';
import { makeProviderClassifier } from '../services/dispatch-classifier.js';
import { parseMcpArgs, runMcpManagementCommand } from '../services/mcp-management.js';
import { getSuggestions, setSuggestions } from '../services/suggestion-store.js';
import type { SessionStats } from '../session-stats.js';
import { patchConfig } from '../utils.js';
import type { BuiltinSlashCommandDeps } from './slash-commands.js';

type SlashCommandDeps = BuiltinSlashCommandDeps;
type SessionCommandHandlers = Pick<
  SlashCommandDeps,
  | 'onPlugin'
  | 'onContextLimit'
  | 'onMcp'
  | 'mcpRegistry'
  | 'mcpStatus'
  | 'onYolo'
  | 'onNextPredict'
  | 'onSuggestions'
  | 'onExit'
  | 'onBeforeExit'
  | 'onClear'
  | 'onNewSession'
  | 'onDiag'
  | 'onStats'
  | 'generateCommitMessage'
  | 'onDispatchClassify'
>;

interface ErrorRecord {
  ts: string;
  phase: string;
  code: string;
  message: string;
}

interface SessionCommandHandlersInput {
  getConfig: () => Config;
  setConfig: (config: Config) => void;
  configStore: ConfigStore;
  profileConfigPath: string;
  context: Context;
  effectiveMaxContext: { current: number };
  autoCompactor?: { setMaxContext(tokens: number): void } | undefined;
  events: EventBus;
  setEventMaxContext: (tokens: number) => void;
  mcpRegistry: MCPRegistry;
  onYolo: NonNullable<SlashCommandDeps['onYolo']>;
  getNextPredict: () => boolean;
  setNextPredict: (enabled: boolean) => void;
  getCurrentSuggestions: () => string[];
  setCurrentSuggestions: (suggestions: string[]) => void;
  teardownHandlers: Array<() => void>;
  multiAgentHost: MultiAgentHost;
  pluginHost?: { dispose(): Promise<void> } | undefined;
  logger: { warn(message: string): void };
  projectRoot: string;
  flags: Record<string, string | boolean>;
  tokenCounter: TokenCounter;
  errorRing: ErrorRecord[];
  toolRegistry: ToolRegistry;
  stats: SessionStats;
}

export function createSessionCommandHandlers(
  input: SessionCommandHandlersInput,
): SessionCommandHandlers {
  return {
    onPlugin: async (args) => {
      const result = await runPluginManagementCommand(
        args.length === 0 ? [] : args.split(/\s+/).filter(Boolean),
        { config: input.getConfig(), configPath: input.profileConfigPath },
      );
      if (result.patch) {
        const configPatch = result.patch as never as Partial<Config>;
        input.setConfig(patchConfig(input.getConfig(), configPatch));
        input.configStore.update(configPatch);
      }
      if (result.restartRequired && result.code === 0) {
        return `${result.message}\nRestart WrongStack to load or unload plugin code in this session.`;
      }
      return result.message;
    },
    onContextLimit: (tokens) => {
      if (typeof tokens === 'number' && Number.isFinite(tokens) && tokens > 0) {
        input.effectiveMaxContext.current = tokens;
        input.context.provider.capabilities.maxContext = tokens;
        input.context.meta['effectiveMaxContext'] = tokens;
        input.autoCompactor?.setMaxContext(tokens);
        input.events.emit('ctx.max_context', {
          sessionId: input.context.session.id,
          providerId: input.getConfig().provider,
          modelId: input.context.model,
          maxContext: tokens,
        });
        input.setEventMaxContext(tokens);
      }
      return input.effectiveMaxContext.current;
    },
    onMcp: async (args) => {
      const parsed = parseMcpArgs(args);
      if (!parsed) {
        return [
          'Usage: /mcp [list|add <name>|remove <name>|enable <name>|disable <name>|restart <name>]',
          'Run `/mcp` without args to see available servers.',
        ].join('\n');
      }
      return runMcpManagementCommand(parsed, {
        config: input.getConfig(),
        configPath: input.profileConfigPath,
        mcpRegistry: input.mcpRegistry,
        allServerPresets: allServers(),
      });
    },
    mcpRegistry: input.mcpRegistry,
    mcpStatus: () =>
      input.mcpRegistry.describe().map((server) => ({
        name: server.name,
        state: server.state,
        enabled: server.enabled,
        toolCount: server.toolCount,
      })),
    onYolo: input.onYolo,
    onNextPredict: (enabled) => {
      if (enabled !== undefined) {
        input.setNextPredict(enabled);
        input.setConfig(patchConfig(input.getConfig(), { nextPrediction: enabled }));
        return enabled;
      }
      return input.getNextPredict();
    },
    onSuggestions: (suggestions) => {
      if (suggestions !== undefined) {
        input.setCurrentSuggestions(suggestions);
        setSuggestions(suggestions);
      }
      const shared = getSuggestions();
      return shared.length > 0 ? shared : input.getCurrentSuggestions();
    },
    onExit: () => disposeSession(input),
    onBeforeExit: () => checkUncommittedChanges(input.projectRoot),
    onClear: () => {
      if (input.flags.tui && !input.flags['no-tui']) return;
      try {
        writeOut('\x1b[2J\x1b[3J\x1b[H');
      } catch {
        // stdout may already be closed during shutdown.
      }
    },
    onNewSession: async () => {},
    onDiag: () => formatDiagnostics(input),
    onStats: () => input.stats.format(),
    generateCommitMessage: (diff) =>
      generateCommitMessageWithLLM(diff, {
        provider: input.context.provider as CommitLLMProvider,
        model: input.context.model,
      }),
    onDispatchClassify: makeProviderClassifier(
      input.context.provider as CommitLLMProvider,
      input.context.model,
    ),
  };
}

async function disposeSession(input: SessionCommandHandlersInput): Promise<void> {
  for (const teardown of input.teardownHandlers) teardown();
  input.teardownHandlers.length = 0;
  const [mcpResult, multiAgentResult, pluginResult] = await Promise.allSettled([
    input.mcpRegistry.stopAll(),
    input.multiAgentHost.dispose(),
    input.pluginHost?.dispose() ?? Promise.resolve(),
  ]);
  for (const [label, result] of [
    ['mcpRegistry.stopAll()', mcpResult],
    ['multiAgentHost.dispose()', multiAgentResult],
    ['pluginHost.dispose()', pluginResult],
  ] as const) {
    if (result.status === 'rejected') {
      input.logger.warn(
        `${label} failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
      );
    }
  }
}

async function checkUncommittedChanges(projectRoot: string) {
  const result = await new Promise<{ stdout: string; code: number }>((resolve, reject) => {
    const child = spawn('git', ['status', '--porcelain'], {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: AbortSignal.timeout(5000),
      windowsHide: true,
    });
    let stdout = '';
    child.stdout?.on('data', (data) => {
      stdout += data;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, code: code ?? 0 }));
  });
  if (!result.stdout.trim()) return undefined;
  const count = result.stdout.split('\n').filter(Boolean).length;
  return {
    abort: true,
    message: `⚠ ${color.yellow(`${count} uncommitted change${count > 1 ? 's' : ''}`)} — session ended without commit`,
  };
}

function formatDiagnostics(input: SessionCommandHandlersInput): string {
  const tokens = input.tokenCounter.total();
  const cost = input.tokenCounter.estimateCost();
  const errors =
    input.errorRing.length === 0
      ? []
      : [
          '',
          `${color.bold('Recent errors')} (last ${input.errorRing.length}):`,
          ...input.errorRing.map(
            (error) => `  [${error.ts}] ${error.phase} ${error.code} — ${error.message}`,
          ),
        ];
  const effects = input.context.sideEffects ?? [];
  const sideEffects =
    effects.length === 0
      ? []
      : [
          '',
          `${color.bold('Side effects')} (last ${effects.length}):`,
          ...effects.slice(-20).map((effect) => {
            const detail = effect.outcome ? ` → ${effect.outcome}` : '';
            const subject =
              effect.input['command'] ??
              effect.input['url'] ??
              effect.input['packages'] ??
              JSON.stringify(effect.input).slice(0, 60);
            return `  ${effect.ts.slice(11, 19)}  ${effect.toolName.padEnd(8)} ${effect.risk.padEnd(7)} ${subject}${detail}`;
          }),
        ];
  const config = input.configStore.get();
  const family = config.providers?.[config.provider]?.family;
  return [
    color.bold('WrongStack diag'),
    `  provider:     ${config.provider} / ${input.context.model}`,
    family ? `  family:       ${family}` : null,
    `  projectRoot:  ${input.projectRoot}`,
    `  tokens:       in ${tokens.input}  out ${tokens.output}  cacheR ${tokens.cacheRead ?? 0}`,
    `  cost:         ${cost.total.toFixed(4)}`,
    `  tools:        ${input.toolRegistry.list().length}`,
    `  mcpServers:   ${input.mcpRegistry.list().length}`,
    ...errors,
    ...sideEffects,
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
}
