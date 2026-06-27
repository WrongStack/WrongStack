import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { SlashCommand } from '@wrongstack/core';
import {
  applyTokenOverrides,
  clearActiveKit,
  clearPersistedActiveKit,
  color,
  getDesignKitLoader,
  getDesignState,
  isDesignStack,
  loadActiveKit,
  materializeTokens,
  recordOverrides,
  setActiveKit,
  setDesignOverrides,
} from '@wrongstack/core';
import type { SlashCommandContext } from './index.js';

/** Parse `key=value key2=value2` override pairs from slash args. */
function parseOverridePairs(tokens: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of tokens) {
    const eq = t.indexOf('=');
    if (eq > 0) out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return out;
}

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
      '  /design set <k=v> …        Override kit colors/tokens (e.g. primary=oklch(62% 0.2 25) dark.bg=#111)',
      '  /design materialize [stack] [path]  Write the active kit tokens to a real theme file',
      '  /design verify             Scan UI files for off-palette colors',
      '',
      'Examples:',
      '  /design minimal-clarity web',
      '  /design set primary=oklch(62% 0.2 25)',
      '  /design materialize web src/styles/tokens.css',
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

      if (sub === 'verify') {
        return { runText: 'design verify' };
      }

      if (sub === 'set') {
        const patch = parseOverridePairs(tokens.slice(1));
        if (Object.keys(patch).length === 0) {
          return { message: 'Usage: /design set primary=oklch(…) dark.bg=#111' };
        }
        const merged = await recordOverrides(opts.projectRoot, patch, new Date().toISOString());
        if (!merged) {
          return { message: 'No active kit. Pin one first: /design <kit-id>.' };
        }
        if (ctx) setDesignOverrides(ctx, merged);
        const list = Object.entries(merged)
          .map(([k, v]) => `${k}=${v}`)
          .join(', ');
        return { message: color.green(`Overrides set: ${list || '(none)'}`) };
      }

      if (sub === 'materialize') {
        const active = await loadActiveKit(opts.projectRoot);
        if (!active) {
          return { message: 'No active kit. Pin one first: /design <kit-id>.' };
        }
        const stackArg2 = tokens[1]?.toLowerCase();
        const matStack =
          stackArg2 && isDesignStack(stackArg2)
            ? stackArg2
            : active.stack && isDesignStack(active.stack)
              ? active.stack
              : 'web';
        const outPath = stackArg2 && !isDesignStack(stackArg2) ? tokens[1] : tokens[2];
        const raw = await loader.readTokens(active.kit);
        if (!raw) return { message: `Kit "${active.kit}" has no tokens.json.` };
        const merged = applyTokenOverrides(raw, active.overrides);
        const result = materializeTokens({
          tokens: merged,
          stack: matStack,
          kitId: active.kit,
          outPath,
        });
        const abs = path.join(opts.projectRoot, result.path);
        try {
          await fs.mkdir(path.dirname(abs), { recursive: true });
          await fs.writeFile(abs, result.content);
        } catch (e) {
          return { message: `Failed to write ${result.path}: ${(e as Error).message}` };
        }
        return {
          message: color.green(`Wrote ${result.format} → ${result.path}`),
          metadata: { designMaterialize: result.path },
        };
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
