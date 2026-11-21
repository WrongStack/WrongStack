// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ToolsSection } from '../../src/components/SettingsPanel/ToolsSection';
import { useSessionLanes } from '../../src/stores/session-lanes';
import type { WSToolsList } from '../../src/types';

const mock = vi.hoisted(() => ({
  send: vi.fn(),
  listeners: new Map<string, (message: WSToolsList) => void>(),
}));
const client = {
  send: mock.send,
  on: (type: string, callback: (message: WSToolsList) => void) => {
    mock.listeners.set(type, callback);
    return () => mock.listeners.delete(type);
  },
};
vi.mock('@/hooks/useWebSocket', () => ({ useWebSocket: () => ({ client }) }));

afterEach(() => {
  cleanup();
  mock.listeners.clear();
  mock.send.mockClear();
});

it('displays Quick group settings for its own session and locks required Kanban', () => {
  const initial = useSessionLanes.getState().activeSessionId;
  useSessionLanes.setState({ activeSessionId: 'quick-tab' });
  try {
    render(<ToolsSection />);
    expect(mock.send).toHaveBeenCalledWith(
      { type: 'tools.list', payload: { sessionId: 'quick-tab' } },
      { echoToChat: false },
    );
    const receive = (sessionId: string, required = false) => {
      act(() => {
        mock.listeners.get('tools.list')?.({
          type: 'tools.list',
          payload: {
            sessionId,
            tools: [],
            toolGroups: [{ group: 'kanban', mode: 'auto', enabled: required, required }],
          },
        });
      });
    };

    receive('other-tab');
    expect(screen.queryByRole('combobox', { name: /Kanban/ })).toBeNull();
    receive('quick-tab');
    fireEvent.change(screen.getByRole('combobox', { name: /Kanban/ }), { target: { value: 'on' } });
    expect(mock.send).toHaveBeenLastCalledWith(
      { type: 'tools.group.set', payload: { sessionId: 'quick-tab', group: 'kanban', mode: 'on' } },
      { echoToChat: false },
    );
    fireEvent.click(screen.getByRole('checkbox', { name: 'Save changes as project defaults' }));
    fireEvent.change(screen.getByRole('combobox', { name: /Kanban/ }), {
      target: { value: 'off' },
    });
    expect(mock.send).toHaveBeenLastCalledWith(
      {
        type: 'tools.group.set',
        payload: { sessionId: 'quick-tab', group: 'kanban', mode: 'off', scope: 'project' },
      },
      { echoToChat: false },
    );
    receive('quick-tab', true);
    expect((screen.getByRole('combobox', { name: /Kanban/ }) as HTMLSelectElement).disabled).toBe(
      true,
    );
  } finally {
    cleanup();
    useSessionLanes.setState({ activeSessionId: initial });
  }
});
