import type { SlashCommand } from '@wrongstack/core/types';
import { color, getToolDescriptionMode } from '@wrongstack/core/utils';
import type { SlashCommandContext } from './command-context.js';

function fit(text: string, width: number): string {
  if (text.length <= width) return text.padEnd(width);
  return `${text.slice(0, Math.max(0, width - 3))}...`;
}

function formatDescriptionMode(mode: 'extend' | 'simple'): string {
  const raw = `desc:${mode}`;
  return mode === 'simple' ? color.amber(raw) : color.dim(raw);
}

/**
 * Three states, not two. `active` used to mean "not disabled", which quietly
 * lumped together tools whose schema goes to the model on every turn and tools
 * the token-saving tier keeps out of the request entirely. On the default tier
 * that is over half the catalogue listed as `active` while the model cannot
 * see any of it, so this table never matched what the request actually sent.
 *
 * `lazy` is the honest name for the second group: still executable through
 * `tool_search` / `tool_use`, just not paid for on every request. The TUI
 * picker and the WebUI tools panel have shown this split for a while - these
 * text tables (used by `--print`, pipes and SimpleUI) were the surfaces left
 * reporting two states for three.
 */
function toolStatus(
  reg: { isDisabled(name: string): boolean; isExposedToProvider?(name: string): boolean },
  name: string,
): string {
  if (reg.isDisabled(name)) return color.red('disabled');
  if (reg.isExposedToProvider?.(name) === false) return color.cyan('lazy');
  return color.green('direct');
}

export function buildToolsCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'tools',
    category: 'Inspect',
    description:
      'List registered tools. Pass a pattern to filter by name or owner: /tools <pattern>.',
    argsHint: '[name-or-owner filter]',
    async run(args) {
      const reg = opts.toolRegistry;
      const filter = args.trim().toLowerCase();
      const allTools = [...reg.listWithOwner(), ...reg.listDisabled()];
      const all = filter
        ? allTools.filter(
            ({ tool, owner }) =>
              tool.name.toLowerCase().includes(filter) || owner.toLowerCase().includes(filter),
          )
        : allTools;
      const disabled = reg.listDisabled();

      // TUI mode: bare /tools or /tools with a filter opens the interactive picker.
      if (opts.onPanelOpen?.current) {
        // In TUI mode, always open the picker (with or without a filter).
        // The picker supports its own inline text filtering.
        const opened = opts.onPanelOpen.current('toolsPickerOpen');
        if (opened) return { message: '' };
      }

      if (filter && all.length === 0) {
        const msg = `${color.bold('Tools')} — no tool name or owner matched "${filter}".`;
        opts.renderer.write(msg);
        return { message: msg };
      }
      const header =
        `  ${color.dim(fit('tool', 28))} ` +
        `${color.dim(fit('owner', 28))} ` +
        `${color.dim(fit('rw', 4))} ` +
        `${color.dim(fit('perm', 8))} ` +
        `${color.dim(fit('status', 10))} ` +
        color.dim('description');
      const lines = all.map(({ tool, owner }) => {
        const mode = getToolDescriptionMode(reg, tool.name);
        const rw = tool.mutating ? color.yellow(fit('mut', 4)) : color.cyan(fit('ro', 4));
        const status = toolStatus(reg, tool.name);
        return (
          `  ${fit(tool.name, 28)} ` +
          `${color.dim(fit(`[${owner}]`, 28))} ` +
          `${rw} ` +
          `${color.dim(fit(tool.permission, 8))} ` +
          `${fit(status, 10)} ` +
          formatDescriptionMode(mode)
        );
      });
      const lazy = allTools.filter(
        ({ tool }) => !reg.isDisabled(tool.name) && reg.isExposedToProvider?.(tool.name) === false,
      );
      const notes: string[] = [];
      if (lazy.length > 0) {
        notes.push(
          `${lazy.length} tool(s) held back from the provider by the token-saving tier - still callable via tool_search/tool_use. Change with /settings token-saving <tier>.`,
        );
      }
      if (disabled.length > 0) {
        notes.push(
          `${disabled.length} tool(s) disabled. Use /tool enable <name> or /tool enable-all to restore.`,
        );
      }
      const extra = notes.length > 0 ? `\n${color.dim(notes.join('\n'))}` : '';
      const filterNote = filter
        ? color.dim(` matching "${filter}" (${all.length} of ${allTools.length})`)
        : '';
      const directCount = allTools.filter(
        ({ tool }) => !reg.isDisabled(tool.name) && reg.isExposedToProvider?.(tool.name) !== false,
      ).length;
      const msg = `${color.bold('Tools')}${filterNote} (${all.length} shown, ${directCount} direct, ${lazy.length} lazy, ${disabled.length} disabled) ${color.dim('description detail via /tool <name> simple|extend')}:\n${header}\n${lines.join('\n')}${extra}\n`;
      opts.renderer.write(msg);
      return { message: msg };
    },
  };
}
