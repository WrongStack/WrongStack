import { describe, expect, it } from 'vitest';
import type { ACPProgressEvent } from '../src/client/acp-session-types.js';
import { createSessionScratch, handleAcpSessionUpdate } from '../src/client/acp-session-updates.js';
import type { ACPMessage } from '../src/types/acp-messages.js';

function sendUpdate(
  update: Record<string, unknown>,
  scratch = createSessionScratch(),
): { events: ACPProgressEvent[]; scratch: ReturnType<typeof createSessionScratch> } {
  const events: ACPProgressEvent[] = [];
  const msg = {
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId: 's1', update },
  } as unknown as ACPMessage;
  handleAcpSessionUpdate(msg, scratch, (ev) => events.push(ev));
  return { events, scratch };
}

describe('ACP client session/update parity', () => {
  it('emits typed progress events for commands, mode, config_options, and session_info updates', () => {
    const cmdRes = sendUpdate({
      sessionUpdate: 'available_commands_update',
      availableCommands: [{ name: 'compact', description: 'Compact history' }],
    });
    expect(cmdRes.events).toContainEqual({
      type: 'commands',
      commands: [{ name: 'compact', description: 'Compact history' }],
    });

    const modeRes = sendUpdate({
      sessionUpdate: 'current_mode_update',
      currentModeId: 'plan',
    });
    expect(modeRes.events).toContainEqual({ type: 'mode', modeId: 'plan' });

    const cfgRes = sendUpdate({
      sessionUpdate: 'config_option_update',
      configOptions: [
        {
          id: 'model',
          category: 'model',
          type: 'select',
          name: 'Model',
          currentValue: 'claude-opus-5-5',
          options: [{ value: 'claude-opus-5-5', name: 'Claude Opus 5.5' }],
        },
      ],
    });
    expect(cfgRes.events).toContainEqual({
      type: 'config_options',
      options: [
        {
          id: 'model',
          category: 'model',
          name: 'Model',
          description: undefined,
          currentValue: 'claude-opus-5-5',
          options: [{ value: 'claude-opus-5-5', name: 'Claude Opus 5.5' }],
        },
      ],
    });

    const infoRes = sendUpdate({
      sessionUpdate: 'session_info_update',
      title: 'Fix ACP client parity',
      updatedAt: '2026-11-22T18:00:00Z',
    });
    expect(infoRes.events).toContainEqual({
      type: 'session_info',
      title: 'Fix ACP client parity',
      updatedAt: '2026-11-22T18:00:00Z',
    });
  });

  it('captures tool_call locations and attached terminalIds across updates', () => {
    const scratch = createSessionScratch();
    sendUpdate(
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-1',
        title: 'Run tests',
        kind: 'execute',
        status: 'in_progress',
        rawInput: { command: 'bun test' },
        locations: [{ path: 'src/index.ts', line: 42 }],
        content: [{ type: 'terminal', terminalId: 'term-1' }],
      },
      scratch,
    );
    const { events } = sendUpdate(
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-1',
        status: 'completed',
        content: [
          { type: 'terminal', terminalId: 'term-2' },
          { type: 'content', content: { type: 'text', text: 'passed' } },
        ],
      },
      scratch,
    );
    const captured = scratch.toolCalls.get('tc-1');
    expect(captured?.locations).toEqual([{ path: 'src/index.ts', line: 42 }]);
    expect(captured?.terminalIds).toEqual(['term-1', 'term-2']);
    expect(captured?.output).toBe('passed');
    expect(events.some((e) => e.type === 'tool_call_update')).toBe(true);
  });
});
