import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ToolsSection } from '../../src/components/SettingsPanel/ToolsSection.js';

const client = vi.hoisted(() => {
  const handlers = new Map<string, (message: unknown) => void>();
  return {
    handlers,
    send: vi.fn(),
    on(name: string, handler: (message: unknown) => void) {
      handlers.set(name, handler);
      return () => {
        handlers.delete(name);
      };
    },
  };
});
vi.mock('@/hooks/useWebSocket', () => ({ useWebSocket: () => ({ client }) }));

describe('ToolFlow tools settings', () => {
  it('labels an operator diagnostic separately from the lazy model catalog', () => {
    render(<ToolsSection />);
    act(() =>
      client.handlers.get('tools.list')?.({
        payload: {
          tools: [
            {
              name: 'scanner_status',
              owner: 'scanner',
              description: 'Scanner status',
              params: [],
              disabled: false,
              direct: false,
              operatorOnly: true,
              mutating: false,
              permission: 'auto',
            },
          ],
        },
      }),
    );
    expect(screen.getByText('operator')).toBeTruthy();
    expect(screen.getByText(/0 lazy · 1 operator/)).toBeTruthy();
    expect(screen.queryByText('lazy')).toBeNull();
  });

  it.each([false, true])(
    'is searchable by product name and toggles its canonical ID (disabled=%s)',
    (disabled) => {
      client.send.mockClear();
      render(<ToolsSection />);
      act(() =>
        client.handlers.get('tools.list')?.({
          payload: {
            tools: [
              {
                name: 'tool_script',
                owner: 'core',
                description: 'WrongStack ToolFlow',
                params: ['script'],
                disabled,
                direct: false,
                mutating: false,
                permission: 'auto',
              },
              {
                name: 'read',
                owner: 'core',
                description: 'Read a file',
                params: ['path'],
                disabled: false,
                direct: true,
                mutating: false,
                permission: 'auto',
              },
            ],
          },
        }),
      );
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'ToolFlow' } });
      expect(screen.getByText('WrongStack ToolFlow')).toBeTruthy();
      expect(screen.queryByText('read')).toBeNull();
      expect(screen.getByText(disabled ? 'disabled' : 'lazy')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: disabled ? 'Enable' : 'Disable' }));
      expect(client.send).toHaveBeenCalledWith({
        type: disabled ? 'tool.enable' : 'tool.disable',
        payload: { name: 'tool_script' },
      });
    },
  );
});
