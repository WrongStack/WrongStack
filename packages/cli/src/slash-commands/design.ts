import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { SlashCommand } from '@wrongstack/contracts/types';
import {
  applyTokenOverrides,
  captureProjectTokens,
  clearActiveKit,
  clearPersistedActiveKit,
  getDesignKitLoader,
  getDesignState,
  isDesignStack,
  loadActiveKit,
  materializeTokens,
  recordOverrides,
  resolveMaterializeTarget,
  resolveSemanticTune,
  resolveVerifyTokens,
  type SemanticTune,
  saveCapturedTokens,
  setActiveKit,
  setDesignOverrides,
} from '@wrongstack/core/design';
import { color } from '@wrongstack/core/utils';
import type { SlashCommandContext } from './command-context.js';

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
    argsHint: '[<kit-id> [stack] | extract <url> [pages] | off | foundations]',
    help: [
      'Usage:',
      '  /design                    List available design kits + the active one',
      '  /design <kit-id> [stack]   Pin a kit and load its full spec (stack: web|react-native|flutter|swiftui|compose)',
      '  /design extract <url|file> [maxPages]  Extract DESIGN.md + design DNA across 5 breakpoints',
      '  /design compare <ref> <url|file>       Compare an implementation against an extracted reference',
      '  /design inspect <url|file>             Inspect a rendered page for layout/contrast defects',
      '  /design draw <job> [photo|product|words]  Deal a job-native page anatomy before writing UI',
      '  /design snapshot [files…]  Snapshot routes, form inputs & handlers before a redesign',
      '  /design kept [files…]      Verify pre-redesign wiring survived the redesign',
      '  /design document [out]     Write the active kit or captured tokens as DESIGN.md',
      '  /design off                Clear the active kit',
      '  /design foundations        Print the mandatory responsive/a11y/theming/motion baseline',
      '  /design set <k=v> …        Override kit colors/tokens (e.g. primary=oklch(62% 0.2 25) dark.bg=#111)',
      '  /design tune <k=v> …       High-level knobs (radius=lg density=compact font="Space Grotesk" motion=snappy)',
      '  /design swap <kit-id> [stack]  Switch to a different kit, dropping the old kit overrides',
      '  /design capture [files…]   Extract tokens from DESIGN.md or existing CSS/Tailwind into .design/captured.json',
      '  /design materialize [stack] [path]  Write the active kit or captured tokens to a real theme file',
      '  /design verify             Scan UI files for token drift (color/radius/spacing)',
      '',
      'Examples:',
      '  /design extract https://stripe.com 6',
      '  /design compare stripe-com index.html',
      '  /design minimal-clarity web',
      '  /design set primary=oklch(62% 0.2 25)',
      '  /design tune radius=lg density=compact',
      '  /design swap neo-brutalist web',
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

      if (sub === 'snapshot' || sub === 'kept') {
        const files = tokens.slice(1).filter(Boolean);
        const payload = files.length > 0 ? { action: sub, files } : { action: sub };
        return { runText: `design ${JSON.stringify(payload)}` };
      }

      if (sub === 'document') {
        const out = tokens[1];
        const payload = out ? { action: 'document', out, force: true } : { action: 'document' };
        return { runText: `design ${JSON.stringify(payload)}` };
      }

      if (sub === 'extract') {
        const target = tokens[1];
        if (!target) {
          return { message: 'Usage: /design extract <url-or-file> [maxPages]' };
        }
        const rawPages = tokens[2]?.replace(/^pages=/i, '');
        const maxPages = rawPages ? Number(rawPages) : undefined;
        if (
          maxPages !== undefined &&
          (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 8)
        ) {
          return {
            message: 'Usage: /design extract <url-or-file> [maxPages] (maxPages must be 1–8)',
          };
        }
        const isHttp = /^https?:\/\//i.test(target);
        const payload = {
          action: 'extract',
          ...(isHttp ? { url: target } : { file: target }),
          ...(maxPages !== undefined ? { maxPages } : {}),
        };
        return { runText: `design_reference ${JSON.stringify(payload)}` };
      }

      if (sub === 'compare') {
        const ref = tokens[1];
        const target = tokens[2];
        if (!ref || !target) {
          return { message: 'Usage: /design compare <reference-slug> <url-or-file>' };
        }
        const isHttp = /^https?:\/\//i.test(target);
        const payload = {
          action: 'compare',
          reference: ref,
          ...(isHttp ? { url: target } : { file: target }),
        };
        return { runText: `design_reference ${JSON.stringify(payload)}` };
      }

      if (sub === 'inspect') {
        const target = tokens[1];
        if (!target) {
          return { message: 'Usage: /design inspect <url-or-file> [hero]' };
        }
        const stageArg = tokens[2]?.toLowerCase();
        const isHttp = /^https?:\/\//i.test(target);
        const payload = {
          action: 'inspect',
          ...(isHttp ? { url: target } : { file: target }),
          ...(stageArg === 'hero' || stageArg === 'full' ? { stage: stageArg } : {}),
        };
        return { runText: `design_reference ${JSON.stringify(payload)}` };
      }

      if (sub === 'draw') {
        const job = tokens[1];
        if (!job) {
          return {
            message:
              'Usage: /design draw <subscribe|book|visit|attend|buy|try|sign-up|hire|join|listen|dashboard> [photo|product|words]',
          };
        }
        const material = tokens[2];
        const pairs = parseOverridePairs(tokens.slice(2));
        const payload = {
          action: 'draw',
          job,
          ...(material && !material.includes('=') ? { material } : {}),
          ...(pairs['material'] ? { material: pairs['material'] } : {}),
          ...(pairs['seed'] ? { seed: pairs['seed'] } : {}),
        };
        return { runText: `design ${JSON.stringify(payload)}` };
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

      if (sub === 'tune') {
        const pairs = parseOverridePairs(tokens.slice(1));
        const tune: SemanticTune = {
          radius: pairs['radius'],
          density: pairs['density'],
          font: pairs['font'],
          motion: pairs['motion'],
        };
        const patch = resolveSemanticTune(tune);
        if (Object.keys(patch).length === 0) {
          return {
            message: 'Usage: /design tune radius=lg density=compact font="…" motion=snappy',
          };
        }
        const merged = await recordOverrides(opts.projectRoot, patch, new Date().toISOString());
        if (!merged) {
          return { message: 'No active kit. Pin one first: /design <kit-id>.' };
        }
        if (ctx) setDesignOverrides(ctx, merged);
        const list = Object.entries(patch)
          .map(([k, v]) => `${k}=${v}`)
          .join(', ');
        return {
          message: color.green(`Tuned (${Object.keys(patch).length} tokens): ${list}`),
        };
      }

      if (sub === 'swap') {
        const target = tokens[1]?.toLowerCase();
        if (!target) return { message: 'Usage: /design swap <kit-id> [stack]' };
        const kit = await loader.find(target);
        if (!kit) {
          const menu = await loader.menuText();
          return { message: `Unknown kit "${target}".\n\n${menu}` };
        }
        const stackArg = tokens[2]?.toLowerCase();
        const stack = stackArg && isDesignStack(stackArg) ? stackArg : undefined;
        // Fresh switch: drop the prior kit's overrides before pinning the new one.
        await clearPersistedActiveKit(opts.projectRoot);
        if (ctx) setActiveKit(ctx, kit.id, stack, {});
        return {
          message: color.green(
            `Swapped to design kit "${kit.name}" (${kit.id}). Old overrides dropped.`,
          ),
          runText: `design use ${kit.id}${stack ? ` --stack ${stack}` : ''}`,
          metadata: { designKit: kit.id, ...(stack ? { designStack: stack } : {}) },
        };
      }

      if (sub === 'materialize') {
        const active = await loadActiveKit(opts.projectRoot);
        const captured = active ? undefined : await resolveVerifyTokens(opts.projectRoot);
        if (!active && !captured) {
          return {
            message: 'No active kit or captured tokens. Pin a kit or run /design capture first.',
          };
        }
        const stackArg2 = tokens[1]?.toLowerCase();
        const matStack =
          stackArg2 && isDesignStack(stackArg2)
            ? stackArg2
            : active?.stack && isDesignStack(active.stack)
              ? active.stack
              : 'web';
        const outPath = stackArg2 && !isDesignStack(stackArg2) ? tokens[1] : tokens[2];
        let merged: import('@wrongstack/contracts/types').DesignKitTokens;
        let kitId: string;
        if (active) {
          const raw = await loader.readTokens(active.kit);
          if (!raw) return { message: `Kit "${active.kit}" has no tokens.json.` };
          merged = applyTokenOverrides(raw, active.overrides);
          kitId = active.kit;
        } else {
          merged = captured!.tokens;
          kitId = 'captured-design';
        }
        const activeManifest = active ? await loader.find(active.kit) : undefined;
        const result = materializeTokens({
          tokens: merged,
          stack: matStack,
          kitId,
          outPath,
          photo: activeManifest?.photo,
          fontLinks: activeManifest?.fontLinks,
          darkPaper: activeManifest?.axes?.paper === 'dark',
        });
        // WS-052: share the containment resolver with the tool and WS paths.
        let abs: string;
        try {
          abs = await resolveMaterializeTarget(result.path, opts.projectRoot);
        } catch (e) {
          return { message: (e as Error).message };
        }
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

      if (sub === 'capture') {
        const files = tokens.slice(1).filter(Boolean);
        const result = await captureProjectTokens(opts.projectRoot, {
          files: files.length > 0 ? files : undefined,
        });
        const lightN = Object.keys(result.tokens.light ?? {}).length;
        const darkN = Object.keys(result.tokens.dark ?? {}).length;
        if (lightN + darkN === 0) {
          return {
            message:
              `Design capture found no tokens.${result.notes.length ? ` ${result.notes.join(' ')}` : ''}` +
              ' Pass files explicitly: /design capture DESIGN.md',
          };
        }
        const rel = await saveCapturedTokens(opts.projectRoot, {
          stack: result.stack,
          files: result.files,
          tokens: result.tokens,
          palettes: result.palettes,
        });
        return {
          message: color.green(
            `Captured ${lightN + darkN} token value(s) (${lightN} light / ${darkN} dark) from ${result.files.join(', ')} → ${rel}.`,
          ),
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
