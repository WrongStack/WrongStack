import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompanionsButton } from '../../../src/components/ChatInput/companions-button';
import { SubagentModelsButton } from '../../../src/components/ChatInput/subagent-models-button';
import { useGlobalKeyboardShortcuts } from '../../../src/hooks/useGlobalKeyboardShortcuts';
import { useChatStore, useLocalPrefs, useUIStore } from '../../../src/stores';

const sendAbort = vi.fn();
vi.mock('@/lib/ws-client', () => ({ getWSClient: () => ({ sendAbort }) }));
vi.mock('@/hooks/useWebSocket', () => ({ useWebSocket: () => ({ updatePrefs: vi.fn() }) }));

const shortcuts = {
  toggleSidebar: vi.fn(),
  setSearchOpen: vi.fn(),
  toggleInspector: vi.fn(),
  setInspectorTab: vi.fn(),
};

beforeEach(() => {
  sendAbort.mockClear();
  useLocalPrefs.setState({ keyboardShortcuts: true });
  useUIStore.setState({ inspectorOpen: false });
  useChatStore.setState({ isLoading: true });
});

afterEach(() => {
  cleanup();
  useChatStore.setState({ isLoading: false });
});

describe('Composer menu Escape ownership', () => {
  it.each([
    ['Companions', CompanionsButton],
    ['Subagents', SubagentModelsButton],
  ] as const)('closes %s without aborting the running conversation', (_name, Menu) => {
    function Harness() {
      useGlobalKeyboardShortcuts(shortcuts);
      return <Menu />;
    }
    render(<Harness />);
    const trigger = screen.getByRole('button', { expanded: false });
    fireEvent.keyDown(trigger, { key: 'Escape', bubbles: true, cancelable: true });
    expect(sendAbort).toHaveBeenCalledTimes(1);
    sendAbort.mockClear();
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');

    fireEvent.keyDown(trigger, { key: 'Escape', bubbles: true, cancelable: true });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
    expect(sendAbort).not.toHaveBeenCalled();

    // Control: the next Escape belongs to the conversation after the menu closes.
    fireEvent.keyDown(trigger, { key: 'Escape', bubbles: true, cancelable: true });
    expect(sendAbort).toHaveBeenCalledTimes(1);
  });
});
