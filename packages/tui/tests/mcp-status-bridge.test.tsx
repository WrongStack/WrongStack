import { EventBus } from '@wrongstack/contracts/kernel';
import { useReducer } from 'react';
import { expect, it } from 'vitest';
import { reducer } from '../src/app-reducer.js';
import type { State } from '../src/app-state.js';
import { useMcpStatusBridge } from '../src/hooks/use-mcp-status-bridge.js';
import { Text } from '../src/ink.js';
import { createTestState } from './helpers/create-test-state.js';
import { renderRealTty, settle } from './helpers/real-tty.js';

it('shows a terminal MCP failure once, stays quiet about routine drops, and reports recovery', async () => {
  const events = new EventBus();
  const seen: { current: State | undefined } = { current: undefined };
  function Harness() {
    const [state, dispatch] = useReducer(reducer, createTestState());
    seen.current = state;
    useMcpStatusBridge({ events, dispatch });
    return <Text>{state.entries.length}</Text>;
  }
  const lines = () =>
    (seen.current?.entries ?? [])
      .filter((e) => e.kind === 'warn' || e.kind === 'info')
      .map((e) => `${e.kind}: ${(e as { text: string }).text}`);
  const view = renderRealTty(<Harness />, { columns: 120, rows: 10 });
  try {
    await settle();
    const emit = events.emit as unknown as (name: string, payload: unknown) => void;
    // Routine: an idle sleep and a crash that an automatic reconnect follows.
    emit.call(events, 'mcp.server.disconnected', { name: 'lazy', reason: 'idle-sleep' });
    emit.call(events, 'mcp.server.disconnected', { name: 'flaky', reason: 'exit:1' });
    await settle();
    expect(lines()).toEqual([]);

    // Terminal: shown once, even when announced twice.
    const down = { name: 'flaky', reason: 'reconnect-exhausted:5\nstack', terminal: true };
    emit.call(events, 'mcp.server.disconnected', down);
    emit.call(events, 'mcp.server.disconnected', down);
    await settle();
    expect(lines()).toEqual([
      'warn: MCP server "flaky" is not connected (reconnect-exhausted:5); its tools are unavailable. Retry with /mcp restart flaky.',
    ]);

    // A server this bridge never reported down connects: nothing to say.
    emit.call(events, 'mcp.server.connected', { name: 'lazy', toolCount: 3 });
    emit.call(events, 'mcp.server.reconnected', { name: 'flaky', toolCount: 2 });
    await settle();
    expect(lines().at(-1)).toBe('info: MCP server "flaky" is connected again.');
    expect(lines()).toHaveLength(2);
  } finally {
    view.unmount();
  }
});
