import type { SlashCommand } from '@wrongstack/core';
import {
  clearActiveKit,
  clearPersistedActiveKit,
  color,
  getDesignKitLoader,
  getDesignState,
  isDesignStack,
  setActiveKit,
} from '@wrongstack/core';
import type { SlashCommandContext } from './index.js';

/**
 * `/design` — manual control over the Design Studio kit picker.
 *
 *   /design                 list kits + show the active one
 *   /design <kit-id> [stack] pin a kit and load its full spec next turn
 *   /design off             clear the active kit (detection stays on)
 *   /design foundations     print the mandatory baseline
 *
 * Pinning sets `ctx.meta.designStudio.activeKit` so the per-turn request
 * middleware switches to the adherence reminder, and emits `runText` so the
 * model loads the full kit body via the `design` tool on the next turn.
 */
export function buildDesignCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'design',
    category: 'Config',
    description: 'Browse/pin a curated UI design kit (Design Studio)',
    argsHint: '[<kit-id> [stack] | off | foundations]',
    help: [
      'Usage:',
      '  /design                    List available design kits + the active one',
      '  /design <kit-id> [stack]   Pin a kit and load its full spec (stack: web|react-native|flutter|swiftui|compose)',
      '  /design off                Clear the active kit',
      '  /design foundations        Print the mandatory responsive/a11y/theming/motion baseline',
      '',
      'Examples:',
      '  /design minimal-clarity web',
      '  /design neo-brutalist',
    ].join('\n'),
    async run(args, ctx) {
      const loader = getDesignKitLoader(opts.projectRoot);
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const sub = tokens[0]?.toLowerCase();

      // No args → list + active.
      if (!sub) {
        const menu = await loader.menuText();
        const state = ctx ? getDesignState(ctx) : undefined;
        const activeLine = state?.activeKit
          ? color.green(`Active kit: ${state.activeKit}${state.stack ? ` (${state.stack})` : ''}`)
          : color.dim('No active kit. The model is free to pick when UI work is detected.');
        return {
          message: `${menu || 'No design kits installed.'}\n\n${activeLine}\n${color.dim('Pin one with /design <kit-id> [stack].')}`,
        };
      }

      if (sub === 'off') {
        if (ctx) clearActiveKit(ctx);
        await clearPersistedActiveKit(opts.projectRoot);
        return { message: 'Cleared the active design kit.' };
      }

      if (sub === 'foundations') {
        return { runText: 'design foundations' };
      }

      // Pin a kit.
      const kit = await loader.find(sub);
      if (!kit) {
        const menu = await loader.menuText();
        return { message: `Unknown kit "${sub}".\n\n${menu}` };
      }
      const stackArg = tokens[1]?.toLowerCase();
      const stack = stackArg && isDesignStack(stackArg) ? stackArg : undefined;
      if (ctx) setActiveKit(ctx, kit.id, stack);
      return {
        message: color.green(`Pinned design kit "${kit.name}" (${kit.id}).`),
        runText: `design use ${kit.id}${stack ? ` --stack ${stack}` : ''}`,
        metadata: { designKit: kit.id, ...(stack ? { designStack: stack } : {}) },
      };
    },
  };
}
