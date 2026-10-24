import type { SlashCommand } from '@wrongstack/contracts/types';
import {
  NEXT_STEPS_MODES,
  type NextStepsMode,
  resolveNextStepsMode,
} from '@wrongstack/contracts/types';
import { noOpVault } from '@wrongstack/core/security';
import { color, toErrorMessage } from '@wrongstack/core/utils';
import { persistAutonomySetting } from '../settings-menu.js';
import type { SlashCommandContext } from './command-context.js';

/** Offered limits for consecutive automatic turns; 0 = unlimited. */
export const NEXT_STEPS_LIMIT_PRESETS = [5, 10, 20, 50, 100, 0] as const;

const UNLIMITED_WORDS = new Set(['unlimited', 'inf', 'infinite', '∞', 'sonsuz', '0']);

/** Parse a limit argument: a preset, any non-negative integer, or "unlimited". */
export function parseNextStepsLimit(raw: string): number | undefined {
  const value = raw.trim().toLowerCase();
  if (UNLIMITED_WORDS.has(value)) return 0;
  if (!/^\d+$/.test(value)) return undefined;
  return Number.parseInt(value, 10);
}

function formatLimit(n: number): string {
  return n <= 0 ? 'unlimited' : `${n} turns`;
}

const MODE_LABEL: Record<NextStepsMode, string> = {
  optional: `${color.green('OPTIONAL')} ${color.dim('(suggestions only when a concrete follow-on exists)')}`,
  required: `${color.yellow('REQUIRED')} ${color.dim('(every finished turn ends with <nextsteps> or a completion marker)')}`,
};

/**
 * `/nextsteps` — whether the leader must end every finished turn with
 * suggestions (`autonomy.nextSteps`), and how many consecutive automatic turns
 * `auto` autonomy may run on them (`autonomy.autoProceedMaxIterations`).
 */
export function buildNextStepsModeCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'nextsteps',
    category: 'Agent',
    description: 'Make <nextsteps> optional or required, and cap automatic continuation.',
    argsHint: '[optional|required] [limit]',
    help: [
      'Usage:',
      '  /nextsteps                     Show the current mode and auto-continue limit',
      '  /nextsteps optional            Suggestions only when a concrete follow-on exists',
      '  /nextsteps required [limit]    Every finished turn ends with <nextsteps> or <nextsteps-complete/> (default)',
      '  /nextsteps limit <n>           Max consecutive automatic turns: 5 | 10 | 20 | 50 | 100 | unlimited',
      '',
      'In required mode a turn that ends with neither is asked once more for',
      'suggestions, so `auto` autonomy keeps going until the model declares the',
      'work complete or the limit pauses it. Typing anything re-arms the limit.',
    ].join('\n'),
    async run(args) {
      const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
      const autonomy = opts.configStore.get().autonomy;
      const mode = resolveNextStepsMode(autonomy?.nextSteps);
      const limit = autonomy?.autoProceedMaxIterations ?? 0;

      if (parts.length === 0 || parts[0] === 'status') {
        return {
          message: [
            `Next steps: ${MODE_LABEL[mode]}`,
            `Auto-continue limit: ${color.cyan(formatLimit(limit))}`,
          ].join('\n'),
        };
      }

      let nextMode: NextStepsMode | undefined;
      let limitArg: string | undefined;
      const [first, second] = parts;
      if ((NEXT_STEPS_MODES as readonly string[]).includes(first!)) {
        nextMode = first as NextStepsMode;
        limitArg = second;
      } else if (first === 'limit' || first === 'max') {
        limitArg = second;
        if (limitArg === undefined) {
          return {
            message: `${color.amber('Usage:')} /nextsteps limit <${NEXT_STEPS_LIMIT_PRESETS.map((n) => (n === 0 ? 'unlimited' : n)).join('|')}>`,
          };
        }
      } else {
        return {
          message: `${color.amber('Unknown argument')} "${first}". Try: /nextsteps optional | required [limit] | limit <n>`,
        };
      }

      const nextLimit = limitArg === undefined ? undefined : parseNextStepsLimit(limitArg);
      if (limitArg !== undefined && nextLimit === undefined) {
        return {
          message: `${color.red('Invalid limit')}: "${limitArg}". Use 5, 10, 20, 50, 100, any whole number, or unlimited.`,
        };
      }

      if (!opts.paths) return { message: 'Settings persistence is not available in this session.' };
      const activeProfile = opts.configStore.get().activeProfile ?? 'default';
      const apply = (target: Record<string, unknown>): void => {
        if (nextMode) target['nextSteps'] = nextMode;
        if (nextLimit !== undefined) target['autoProceedMaxIterations'] = nextLimit;
      };
      try {
        // Always the profile: `autonomy.nextSteps` is user-owned, and a write
        // under `configScope: project` would land in a file the in-project
        // policy strips it from — live for this session, gone on restart.
        await persistAutonomySetting(
          {
            configStore: opts.configStore,
            profileConfigPath: opts.paths.profileConfig(activeProfile),
            inProjectConfigPath: opts.paths.inProjectConfig,
            vault: opts.vault ?? noOpVault,
            forceGlobal: true,
            updateStore: false,
          },
          (target) => apply(target as Record<string, unknown>),
        );
      } catch (err) {
        return { message: `${color.red('Failed to save')}: ${toErrorMessage(err)}` };
      }
      // Merge into the live config rather than replacing `autonomy` with the
      // profile's copy, which would drop project-level autonomy values.
      const liveAutonomy = { ...(opts.configStore.get().autonomy ?? {}) };
      apply(liveAutonomy as Record<string, unknown>);
      opts.configStore.update({ autonomy: liveAutonomy });

      const lines: string[] = [];
      if (nextMode) lines.push(`${color.green('✓')} Next steps → ${MODE_LABEL[nextMode]}`);
      if (nextLimit !== undefined) {
        lines.push(
          `${color.green('✓')} Auto-continue limit → ${color.cyan(formatLimit(nextLimit))}`,
        );
      }
      return { message: lines.join('\n') };
    },
  };
}
