import type { ModeStore, Tool } from '@wrongstack/core';

interface ModeInput {
  action: 'get' | 'list' | 'set' | 'clear';
  mode?: string | undefined;
}

interface ModeOutput {
  action: string;
  currentMode?: string | undefined;
  modes?: { id: string | undefined; name: string; description: string }[];
  success: boolean;
  message: string;
}

export function createModeTool(modeStore: ModeStore): Tool<ModeInput, ModeOutput> {
  return {
    name: 'mode',
    category: 'Session',
    description:
      'Manage agent operating modes. Modes change the agent\'s behavior, personality, and system prompt for different workflows (e.g. coding, security review, planning).',
    usageHint:
      'POWERFUL BEHAVIOR CONTROL TOOL:\n\n' +
      '- Use `list` to see available modes.\n' +
      '- Use `set <modeId>` to switch the agent into a specific role/mode.\n' +
      '- Use `get` to check current mode.\n' +
      '- Use `clear` to return to default behavior.\n' +
      'Switching modes is very effective for specialized tasks. The mode change affects how the agent reasons and which guidelines it follows.',
    permission: 'confirm',
    mutating: true,
    timeoutMs: 5_000,
    capabilities: ['session.mode'],
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['get', 'list', 'set', 'clear'],
          description: 'The mode operation to perform.',
        },
        mode: {
          type: 'string',
          description: 'The mode identifier to activate (only required when action=set).',
        },
      },
      required: ['action'],
    },
    async execute(input) {
      switch (input.action) {
        case 'get': {
          const mode = await modeStore.getActiveMode();
          return {
            action: 'get',
            currentMode: mode?.id,
            success: true,
            message: mode
              ? `Current mode: ${mode.name} — ${mode.description}`
              : 'No mode set (using default)',
          };
        }
        case 'list': {
          const modes = await modeStore.listModes();
          const lines = modes
            .map((m) => `  ${m.id.padEnd(20)} ${m.name} — ${m.description}`)
            .join('\n');
          return {
            action: 'list',
            modes: modes.map((m) => ({ id: m.id, name: m.name, description: m.description })),
            success: true,
            message: lines,
          };
        }
        case 'set': {
          if (!input.mode) {
            return { action: 'set', success: false, message: 'mode is required for action=set' };
          }
          const mode = await modeStore.getMode(input.mode);
          if (!mode) {
            return { action: 'set', success: false, message: `Mode "${input.mode}" not found` };
          }
          await modeStore.setActiveMode(input.mode);
          return {
            action: 'set',
            currentMode: mode.id,
            success: true,
            message: `Switched to mode: ${mode.name}\n\n${mode.description}`,
          };
        }
        case 'clear': {
          await modeStore.setActiveMode(null);
          return {
            action: 'clear',
            success: true,
            message: 'Mode cleared — using default mode',
          };
        }
        default:
          return {
            action: input.action,
            success: false,
            message: `Unknown action "${input.action}"`,
          };
      }
    },
  };
}
