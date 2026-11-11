import {
  applyTokenOverrides,
  captureProjectTokens,
  clearActiveKit,
  clearPersistedActiveKit,
  getDesignKitLoader,
  isDesignStack,
  loadActiveKit,
  materializeTokens,
  recordOverrides,
  resolveSemanticTune,
  resolveVerifyTokens,
  saveCapturedTokens,
  setActiveKit,
  setDesignOverrides,
} from '@wrongstack/core/design';
import { useEffect } from 'react';
import { registerSlashCommandLifecycle } from '../slash-command-lifecycle.js';
import type { TuiSlashCommandOptions } from './tui-slash-command-options.js';

/**
 * Design-kit-domain slash command (/design), moved verbatim from
 * useTuiSlashCommands (decomposition Phase 2 — docs/decomposition-plan.md).
 * Registers at pinned position 4 (tests/slash-registration-enumeration.test.ts).
 */
export function useDesignKitSlashCommands(deps: TuiSlashCommandOptions): void {
  const { slashRegistry, projectRoot, agent, dispatch } = deps;

  // Register the TUI-only `/design` command. With no args it opens the visual
  // kit picker; with args it pins/clears like the CLI command. The picker's
  // Enter routes back through `/design <id> <stack>`, so this one handler
  // serves both the visual and typed paths.
  useEffect(() => {
    const cmd = {
      name: 'design',
      description:
        'Design Studio: /design (picker) | <kit> [stack] | extract <url|file> [pages] | compare <ref> <url|file> | inspect <url|file> | document [out] | off | foundations | set <k=v> | tune <k=v> | swap <kit> | materialize [stack] [path] | capture [files…] | verify.',
      async run(args: string) {
        const loader = getDesignKitLoader(projectRoot);
        const tokens = (args ?? '').trim().split(/\s+/).filter(Boolean);
        const sub = tokens[0]?.toLowerCase();
        if (!sub) {
          const kits = await loader.listEntries();
          const skipped = await loader.listSkipped();
          dispatch({ type: 'designPickerOpen', kits });
          // Malformed kit folders surface at picker load instead of silently
          // vanishing from the list.
          return {
            message: skipped.length
              ? `⚠️ ${skipped.length} kit folder(s) skipped: ${skipped
                  .map((s) => `${s.dir} — ${s.reason}`)
                  .join('; ')}`
              : undefined,
          };
        }
        if (sub === 'off') {
          clearActiveKit(agent.ctx);
          await clearPersistedActiveKit(projectRoot);
          return { message: 'Cleared the active design kit.' };
        }
        if (sub === 'foundations') {
          return { runText: 'design foundations' };
        }
        if (sub === 'verify') {
          return { runText: 'design verify' };
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
            return { message: 'Usage: /design inspect <url-or-file>' };
          }
          const isHttp = /^https?:\/\//i.test(target);
          const payload = {
            action: 'inspect',
            ...(isHttp ? { url: target } : { file: target }),
          };
          return { runText: `design_reference ${JSON.stringify(payload)}` };
        }
        if (sub === 'set') {
          const patch: Record<string, string> = {};
          for (const t of tokens.slice(1)) {
            const eq = t.indexOf('=');
            if (eq > 0) patch[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
          }
          if (Object.keys(patch).length === 0) {
            return { message: 'Usage: /design set primary=oklch(…) dark.bg=#111' };
          }
          const merged = await recordOverrides(projectRoot, patch, new Date().toISOString());
          if (!merged) return { message: 'No active kit. Pin one first: /design <kit-id>.' };
          setDesignOverrides(agent.ctx, merged);
          return {
            message: `Overrides set: ${Object.entries(merged)
              .map(([k, v]) => `${k}=${v}`)
              .join(', ')}`,
          };
        }
        if (sub === 'tune') {
          const pairs: Record<string, string> = {};
          for (const t of tokens.slice(1)) {
            const eq = t.indexOf('=');
            if (eq > 0) pairs[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
          }
          const patch = resolveSemanticTune({
            radius: pairs['radius'],
            density: pairs['density'],
            font: pairs['font'],
            motion: pairs['motion'],
          });
          if (Object.keys(patch).length === 0) {
            return {
              message: 'Usage: /design tune radius=lg density=compact font="…" motion=snappy',
            };
          }
          const merged = await recordOverrides(projectRoot, patch, new Date().toISOString());
          if (!merged) return { message: 'No active kit. Pin one first: /design <kit-id>.' };
          setDesignOverrides(agent.ctx, merged);
          return {
            message: `Tuned (${Object.keys(patch).length} tokens): ${Object.entries(patch)
              .map(([k, v]) => `${k}=${v}`)
              .join(', ')}`,
          };
        }
        if (sub === 'swap') {
          const target = tokens[1]?.toLowerCase();
          if (!target) return { message: 'Usage: /design swap <kit-id> [stack]' };
          const swapKit = await loader.find(target);
          if (!swapKit) {
            const menu = await loader.menuText();
            return { message: `Unknown kit "${target}".\n\n${menu}` };
          }
          const swapStackArg = tokens[2]?.toLowerCase();
          const swapStack = swapStackArg && isDesignStack(swapStackArg) ? swapStackArg : undefined;
          await clearPersistedActiveKit(projectRoot);
          setActiveKit(agent.ctx, swapKit.id, swapStack, {});
          return {
            message: `Swapped to "${swapKit.name}" (${swapKit.id}). Old overrides dropped.`,
            runText: `design use ${swapKit.id}${swapStack ? ` --stack ${swapStack}` : ''}`,
          };
        }
        if (sub === 'materialize') {
          const active = await loadActiveKit(projectRoot);
          const captured = active ? undefined : await resolveVerifyTokens(projectRoot);
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
          let matTokens: import('@wrongstack/contracts/types').DesignKitTokens;
          let kitId: string;
          if (active) {
            const raw = await loader.readTokens(active.kit);
            if (!raw) return { message: `Kit "${active.kit}" has no tokens.json.` };
            matTokens = applyTokenOverrides(raw, active.overrides);
            kitId = active.kit;
          } else {
            matTokens = captured!.tokens;
            kitId = 'captured-design';
          }
          const result = materializeTokens({
            tokens: matTokens,
            stack: matStack,
            kitId,
            outPath,
          });
          const fsp = await import('node:fs/promises');
          const nodePath = await import('node:path');
          // WS-052: share the containment resolver with the tool and WS paths.
          const { resolveMaterializeTarget } = await import('@wrongstack/core/design');
          let abs: string;
          try {
            abs = await resolveMaterializeTarget(result.path, projectRoot);
          } catch (e) {
            return { message: (e as Error).message };
          }
          try {
            await fsp.mkdir(nodePath.dirname(abs), { recursive: true });
            await fsp.writeFile(abs, result.content);
          } catch (e) {
            return { message: `Failed to write ${result.path}: ${(e as Error).message}` };
          }
          return { message: `Wrote ${result.format} → ${result.path}` };
        }
        if (sub === 'capture') {
          // Kit-less verify: snapshot the project's OWN token source so
          // `design verify` (and the write-time drift check) have a basis
          // while no kit is pinned. Mirrors the tool's capture action.
          const files = tokens.slice(1).filter(Boolean);
          const result = await captureProjectTokens(projectRoot, {
            files: files.length > 0 ? files : undefined,
          });
          const lightN = Object.keys(result.tokens.light ?? {}).length;
          const darkN = Object.keys(result.tokens.dark ?? {}).length;
          if (lightN + darkN === 0) {
            return {
              message:
                `Design capture found no tokens.${result.notes.length ? ` ${result.notes.join(' ')}` : ''}` +
                ' Pass files explicitly: /design capture src/index.css',
            };
          }
          const rel = await saveCapturedTokens(projectRoot, {
            stack: result.stack,
            files: result.files,
            tokens: result.tokens,
            palettes: result.palettes,
          });
          return {
            message:
              `Captured ${lightN + darkN} token value(s) (${lightN} light / ${darkN} dark) from ` +
              `${result.files.join(', ')} → ${rel}. /design verify now runs against them while no kit is pinned.`,
          };
        }
        const kit = await loader.find(sub);
        if (!kit) {
          const menu = await loader.menuText();
          return { message: `Unknown kit "${sub}".\n\n${menu}` };
        }
        const stackArg = tokens[1]?.toLowerCase();
        const stack = stackArg && isDesignStack(stackArg) ? stackArg : undefined;
        setActiveKit(agent.ctx, kit.id, stack);
        return { runText: `design use ${kit.id}${stack ? ` --stack ${stack}` : ''}` };
      },
    };
    return registerSlashCommandLifecycle(slashRegistry, cmd, {
      owner: 'tui',
      official: true,
    });
  }, [slashRegistry, projectRoot, agent]);
}
