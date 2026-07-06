import type { SlashCommand } from '@wrongstack/core';
import { color, getToolDescriptionMode } from '@wrongstack/core';
import type { SlashCommandContext } from './index.js';

function fit(text: string, width: number): string {
  if (text.length <= width) return text.padEnd(width);
  return `${text.slice(0, Math.max(0, width - 3))}...`;
}

function formatDescriptionMode(mode: 'extend' | 'simple'): string {
  const raw = `desc:${mode}`;
  return mode === 'simple' ? color.amber(raw) : color.dim(raw);
}

export function buildToolsCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'tools',
    category: 'Inspect',
    description: 'List registered tools. Pass a pattern to filter by name or owner: /tools <pattern>.',
    argsHint: '[name-or-owner filter]',
    async run(args) {
      const reg = opts.toolRegistry;
      const filter = args.trim().toLowerCase();
      const allTools = reg.listWithOwner();
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
        const status = reg.isDisabled(tool.name) ? color.red('disabled') : color.green('active');
        return (
          `  ${fit(tool.name, 28)} ` +
          `${color.dim(fit(`[${owner}]`, 28))} ` +
          `${rw} ` +
          `${color.dim(fit(tool.permission, 8))} ` +
          `${fit(status, 10)} ` +
          formatDescriptionMode(mode)
        );
      });
      const extra =
        disabled.length > 0
          ? `\n${color.dim(`${disabled.length} tool(s) disabled. Use /tool enable <name> or /tool enable-all to restore.`)}`
          : '';
      const filterNote = filter
        ? color.dim(` matching "${filter}" (${all.length} of ${allTools.length})`)
        : '';
      const msg = `${color.bold('Tools')}${filterNote} (${all.length} shown, ${disabled.length} disabled) ${color.dim('description detail via /tool <name> simple|extend')}:\n${header}\n${lines.join('\n')}${extra}\n`;
      opts.renderer.write(msg);
      return { message: msg };
    },
  };
}
