import type { SlashCommand } from '@wrongstack/core';
import type { SlashCommandContext } from './index.js';

export type { McpParsedArgs } from './mcp-utils.js';
// Re-export for consumers that import from this barrel
export { parseMcpArgs, runMcpManagementCommand } from './mcp-utils.js';

/**
 * /mcp slash command — manage MCP servers from the REPL.
 *
 * Usage:
 *   /mcp              — open interactive server picker (TUI) or list servers
 *   /mcp list         — list all available and configured servers
 *   /mcp add <name>   — add server preset to config (disabled by default)
 *   /mcp add <name> --enable  — add and immediately enable
 *   /mcp remove <name> — remove server from config
 *   /mcp enable <name> — enable server in config + start it
 *   /mcp disable <name> — disable server in config + stop it
 *   /mcp restart <name> — stop and restart a running server
 */
export function buildMcpSlashCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'mcp',
    category: 'Config',
    description:
      'Manage MCP servers: /mcp [list|add <name>|remove <name>|enable <name>|disable <name>|restart <name>]',
    aliases: ['mcp-servers'],
    argsHint: '[list|add <name>|remove <name>|enable <name>|disable <name>|restart <name>]',
    help: [
      'Usage:',
      '  /mcp                      Open interactive server picker (TUI) or list servers.',
      '  /mcp list                 Same.',
      '  /mcp add <name>           Add server preset to config (disabled).',
      '  /mcp add <name> --enable  Add and immediately enable.',
      '  /mcp remove <name>        Remove server from config.',
      '  /mcp enable <name>        Enable server in config + start it.',
      '  /mcp disable <name>       Disable server in config + stop it.',
      '  /mcp restart <name>       Stop and restart a running server (REPL only).',
      '',
      'Examples:',
      '  /mcp',
      '  /mcp add filesystem --enable',
      '  /mcp enable github',
      '  /mcp restart brave-search',
    ].join('\n'),
    async run(args) {
      // TUI mode: bare /mcp or /mcp list opens the interactive picker.
      const trimmed = args.trim();
      if ((trimmed === '' || trimmed === 'list') && opts.onPanelOpen?.current) {
        const opened = opts.onPanelOpen.current('mcpPickerOpen');
        if (opened) return { message: '' };
      }

      if (!opts.onMcp) {
        return { message: 'MCP management is not available in this session.' };
      }
      const result = await opts.onMcp(trimmed);
      return { message: result };
    },
  };
}
