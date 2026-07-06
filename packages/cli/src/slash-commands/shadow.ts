/**
 * /shadow slash command — Start, manage, and stop the Shadow Agent.
 *
 * Usage:
 *   /shadow start [--model=<provider/model>]
 *   /shadow stop
 *   /shadow status
 *   /shadow hoop <agent-id>
 *   /shadow model <provider/model>
 *   /shadow interval <ms>
 */
import type { Context, SlashCommand } from '@wrongstack/core';
import { color, ToolValidationError } from '@wrongstack/core';
import type { SlashCommandContext } from './index.js';

const DEFAULT_SHADOW_INTERVAL_MS = 30_000;
const MIN_SHADOW_INTERVAL_MS = 5_000;

/**
 * /shadow — Shadow Agent management
 *
 * The Shadow Agent is a one-shot monitoring agent that:
 * - Runs only on explicit request or after the host observes problematic work
 * - Tracks all fleet agents and their current tasks
 * - Monitors mailbox state and detects loops
 * - Identifies spike tasks (start/stop instantly)
 * - Provides fleet-wide visibility across all terminals
 * - Uses deterministic evaluation first, LLM only for complex decisions
 * - Can intervene via "hoop" command to stop agents and send notifications
 */
export function buildShadowCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'shadow',
    category: 'Agent',
    aliases: ['shadow-agent'],
    description: 'Start, manage, and stop the Shadow Agent fleet monitor.',
    argsHint: '<start|stop|status|hoop|model|interval> [--flag=value]',
    help: [
      'Usage:',
      '  /shadow start [--model=<provider/model>]',
      '        Run one quiet Shadow Agent fleet check',
      '  /shadow stop',
      '        Stop the Shadow Agent',
      '  /shadow status',
      '        Show all running agents and their current tasks',
      '  /shadow hoop <agent-id> [--reason=<text>]',
      '        Stop the target agent immediately and send notification',
      '  /shadow model <provider/model>',
      '        Change Shadow Agent analysis model',
      '  /shadow interval <ms>',
      '        Change the legacy interval default kept for compatibility',
      '',
      'The Shadow Agent monitors:',
      '  • All fleet agents and their current tasks',
      '  • Mailbox state and message flow',
      '  • Spike tasks (starting/stopping instantly)',
      '  • Fleet-wide activity across all terminals',
      '  • Uses deterministic host rules first; LLM only for manual/problem cases',
      '  • Does not post routine healthy reports',
      '',
      'Model must be specified as provider/model, e.g. provider/configured-model',
      'When omitted, Shadow uses the current leader provider/model.',
      '',
      'Examples:',
      '  /shadow start',
      '  /shadow start --model=provider/configured-model',
      '  /shadow status                       Show all agent activity',
      '  /shadow hoop subagent-abc123        Stop agent and notify',
      '  /shadow hoop subagent-abc --reason=looping  Stop with reason',
    ].join('\n'),
    async run(args: string, _ctx: Context) {
      const [action, ...rest] = args.trim().split(/\s+/);

      switch (action) {
        case undefined:
        case '':
          // TUI mode: bare /shadow opens the interactive panel.
          if (opts.onPanelOpen?.current) {
            const opened = opts.onPanelOpen.current('shadowOpen');
            if (opened) return { message: '' };
          }
          return { message: this.help ?? '/shadow — use /shadow help for usage' };
        case 'start': {
          if (!opts.onSpawn) {
            return { message: '/shadow requires a running director with subagent support.' };
          }

          const flags = parseFlags(rest);
          const shadowDefaults = opts.shadowController?.getDefaults?.();

          let intervalMs: number;
          try {
            intervalMs = parseInterval(
              flags['interval'] ?? String(shadowDefaults?.intervalMs ?? DEFAULT_SHADOW_INTERVAL_MS),
            );
          } catch (e) {
            return { message: `/shadow start: ${(e as Error).message}` };
          }

          // Only one Shadow Agent allowed per session
          if (opts.shadowController?.activeId != null) {
            return {
              message: [
                `${color.yellow('⚠')} A Shadow Agent is already running (${opts.shadowController.activeId.slice(0, 8)}).`,
                '',
                'Only one Shadow Agent instance is allowed per session.',
                'Use /shadow status to view the current instance.',
              ].join('\n'),
            };
          }

          // Validate model format: must be provider/model
          const defaultModelRef = getDefaultModelRef(opts);
          let modelRef: ParsedModelRef;
          const modelRaw = flags['model'];
          if (modelRaw === true) {
            return { message: '/shadow start: --model requires a provider/model value' };
          }
          try {
            modelRef = parseProviderModelRef(modelRaw ?? 'default', defaultModelRef);
          } catch (e) {
            return { message: `/shadow start: ${(e as Error).message}` };
          }
          if (!modelRef.provider || !modelRef.model) {
            return {
              message: '/shadow start: no leader provider/model is configured; pass --model=provider/model',
            };
          }

          const spawnId = await opts.onSpawn(
            `Shadow Agent — one-shot quiet fleet check`,
            {
              provider: modelRef.provider,
              model: modelRef.model,
              tools: [
                'fleet', 'fleet', 'fleet',
                'mailbox', 'mail_inbox', 'mail_send',
                'terminate_subagent',
              ],
              name: 'shadow',
              shadowIntervalMs: intervalMs,
            },
          );

          return { message: `${color.green('✓')} Shadow Agent queued: ${spawnId}\n${color.dim('Mode:')} one-shot quiet check\n${color.dim('Model:')} ${modelRef.label}` };
        }

        case 'stop': {
          const activeId = opts.shadowController?.activeId;
          if (!activeId) {
            return { message: `${color.yellow('⚠')} No active Shadow Agent is registered for this session.` };
          }
          if (!opts.onFleetTerminate) {
            return { message: '/shadow stop requires fleet termination support in this session.' };
          }
          const ok = await opts.onFleetTerminate(activeId);
          if (ok) {
            opts.shadowController?.clear();
            return { message: `${color.green('✓')} Shadow Agent stopped: ${activeId}` };
          }
          return {
            message: [
              `${color.red('✗')} Failed to stop Shadow Agent ${color.bold(activeId)}.`,
              `It may already be stopped. Use ${color.bold('/shadow status')} to inspect active agents.`,
            ].join('\n'),
          };
        }

        case 'status': {
          if (!opts.onAgents) {
            return { message: '/shadow status requires agent monitoring support.' };
          }
          const allAgents = opts.onAgents();
          return { message: allAgents };
        }

        case 'hoop': {
          const [targetId, ...extraArgs] = rest;
          if (!targetId) {
            return { message: '/shadow hoop <agent-id> [--reason=<text>]\nStops the target agent immediately and sends notification.' };
          }

          // Parse --reason flag
          const reasonFlag = extraArgs.find((f) => f.startsWith('--reason='));
          const reason = reasonFlag
            ? reasonFlag.slice('--reason='.length)
            : 'Agent flagged by Shadow Agent';

          if (targetId.toLowerCase() === 'all') {
            if (!opts.onFleetKill) {
              return { message: '/shadow hoop all requires fleet kill support in this session.' };
            }
            const killed = await opts.onFleetKill();
            opts.shadowController?.clear();
            return {
              message: [
                `${color.red('⚠')} HOOP: Stopped ${killed} running agent(s)`,
                '',
                `Target: ${color.bold('all')}`,
                `Reason: ${color.yellow(reason)}`,
              ].join('\n'),
            };
          }

          if (!opts.onFleetTerminate) {
            return { message: '/shadow hoop requires fleet termination support in this session.' };
          }

          const agentInfo = opts.onAgents?.(targetId) ?? '';
          const ok = await opts.onFleetTerminate(targetId);
          if (ok && opts.shadowController?.activeId === targetId) {
            opts.shadowController.clear();
          }

          return {
            message: [
              ok
                ? `${color.red('⚠')} HOOP: Stopped agent`
                : `${color.red('✗')} HOOP: Failed to stop agent`,
              '',
              `Target: ${color.bold(targetId)}`,
              `Reason: ${color.yellow(reason)}`,
              agentInfo ? `\nAgent info:\n${agentInfo}` : '',
            ].join('\n'),
          };
        }

        case 'model': {
          const [modelId] = rest;
          const defaultModelRef = getDefaultModelRef(opts);
          if (!modelId) {
            return { message: `/shadow model <provider/model> — change Shadow Agent analysis model.\nCurrent default: ${defaultModelRef.label}` };
          }
          let parsed: ParsedModelRef;
          try {
            parsed = parseProviderModelRef(modelId, defaultModelRef);
          } catch (e) {
            return { message: `/shadow model: ${(e as Error).message}` };
          }
          opts.shadowController?.setDefaults?.({ provider: parsed.provider, model: parsed.model });
          return { message: `/shadow model ${parsed.label}\n${color.dim('Model will be applied on next /shadow start')}` };
        }

        case 'interval': {
          const [msStr] = rest;
          if (!msStr) {
            return { message: `/shadow interval <ms> — update the legacy Shadow interval default.\nCurrent default: ${DEFAULT_SHADOW_INTERVAL_MS}ms (30 seconds)` };
          }
          let ms: number;
          try {
            ms = parseInterval(msStr);
          } catch (e) {
            return { message: `/shadow interval: ${(e as Error).message}` };
          }
          opts.shadowController?.setDefaults?.({ intervalMs: ms });
          return { message: `/shadow interval ${ms}ms\n${color.dim('Interval will be applied on next /shadow start')}` };
        }

        default: {
          return { message: this.help ?? '/shadow — use /shadow help for usage' };
        }
      }
    },
  };
}

/**
 * Validates and splits a model identifier in the required `provider/model`
 * format. `default` maps to the same provider/model used by host auto-start.
 */
interface ParsedModelRef {
  provider: string;
  model: string;
  label: string;
}

function getDefaultModelRef(opts: SlashCommandContext): ParsedModelRef {
  const shadowDefaults = opts.shadowController?.getDefaults?.();
  const liveConfig = opts.configStore?.get?.();
  const provider = shadowDefaults?.provider?.trim()
    || liveConfig?.provider?.trim()
    || opts.llmProvider?.id?.trim()
    || '';
  const model = shadowDefaults?.model?.trim()
    || liveConfig?.model?.trim()
    || opts.llmModel?.trim()
    || '';
  return {
    provider,
    model,
    label: model ? `${provider}/${model}` : provider,
  };
}

function parseProviderModelRef(model: string, defaultRef: ParsedModelRef): ParsedModelRef {
  if (model === 'default') {
    return defaultRef;
  }
  const slash = model.indexOf('/');
  if (slash <= 0 || slash === model.length - 1) {
    throw new ToolValidationError({
      message: `Model must be in provider/model format (e.g. provider/configured-model), got: "${model}"`,
      field: 'model',
      context: { received: model },
    });
  }
  return {
    provider: model.slice(0, slash),
    model: model.slice(slash + 1),
    label: model,
  };
}

function parseInterval(value: string | true): number {
  if (value === true || !/^\d+$/.test(value)) {
    throw new ToolValidationError({
      message: `interval must be an integer >= ${MIN_SHADOW_INTERVAL_MS}ms`,
      field: 'interval',
    });
  }
  const ms = Number.parseInt(value, 10);
  if (!Number.isFinite(ms) || ms < MIN_SHADOW_INTERVAL_MS) {
    throw new ToolValidationError({
      message: `interval must be an integer >= ${MIN_SHADOW_INTERVAL_MS}ms`,
      field: 'interval',
      context: { received: ms, minimum: MIN_SHADOW_INTERVAL_MS },
    });
  }
  return ms;
}

function parseFlags(args: string[]): Record<string, string | true> {
  return Object.fromEntries(
    args
      .filter((f) => f.startsWith('--'))
      .map((f) => {
        const raw = f.slice(2);
        const eq = raw.indexOf('=');
        return eq >= 0 ? [raw.slice(0, eq), raw.slice(eq + 1)] : [raw, true];
      }),
  );
}

// Backwards-compatible export (slash-commands/index.ts imports this)
export const shadowCommand = buildShadowCommand;
