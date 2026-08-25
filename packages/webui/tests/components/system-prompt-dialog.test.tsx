import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const setSystemPromptVariant = vi.fn();
const newSession = vi.fn();

vi.mock('@/lib/ws-client', () => ({
  getWSClient: () => ({ setSystemPromptVariant, newSession }),
}));

import { SystemPromptDialog } from '../../src/components/SystemPromptDialog.js';
import { useSystemPromptStore } from '../../src/stores/system-prompt-store.js';

const INFO = {
  current: 'default' as const,
  chosen: true,
  variants: [
    { variant: 'lite' as const, label: 'Lite', hint: 'leanest', tokens: 4092 },
    { variant: 'default' as const, label: 'Standard', hint: 'balanced', tokens: 13574 },
    { variant: 'pro' as const, label: 'Pro', hint: 'most detailed', tokens: 20375 },
  ],
};

function open(opts?: { startsSession?: boolean; info?: typeof INFO }) {
  act(() => {
    useSystemPromptStore.setState({
      info: opts?.info ?? INFO,
      pickerOpen: true,
      pickerStartsSession: opts?.startsSession === true,
      promptedThisSession: false,
    });
  });
}

describe('SystemPromptDialog', () => {
  beforeEach(() => {
    setSystemPromptVariant.mockClear();
    newSession.mockClear();
    act(() => {
      useSystemPromptStore.setState({
        info: null,
        pickerOpen: false,
        pickerStartsSession: false,
        promptedThisSession: false,
      });
    });
  });

  afterEach(() => cleanup());

  it('lists every variant with its token estimate and marks the live one', () => {
    render(<SystemPromptDialog />);
    open();

    expect(screen.getByText('Lite')).toBeDefined();
    expect(screen.getByText('~13574 tokens')).toBeDefined();
    // Exactly one "Current" badge, on the variant the session is built from.
    expect(screen.getAllByText('Current')).toHaveLength(1);
  });

  it('sends the variant and does not touch the session when opened from settings', () => {
    render(<SystemPromptDialog />);
    open();

    fireEvent.click(screen.getByText('Pro'));
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    expect(setSystemPromptVariant).toHaveBeenCalledWith('pro');
    expect(newSession).not.toHaveBeenCalled();
    expect(useSystemPromptStore.getState().pickerOpen).toBe(false);
  });

  it('applies the variant before starting the session in the new-session flow', () => {
    render(<SystemPromptDialog />);
    open({ startsSession: true });

    fireEvent.click(screen.getByText('Lite'));
    fireEvent.click(screen.getByRole('button', { name: 'Apply & start session' }));

    // Order matters: `session.new` keeps the process alive, so the new session
    // inherits whichever prompt is live when it starts.
    expect(setSystemPromptVariant.mock.invocationCallOrder[0]).toBeLessThan(
      newSession.mock.invocationCallOrder[0] as number,
    );
    expect(setSystemPromptVariant).toHaveBeenCalledWith('lite');
  });

  it('starts the session without a redundant write when the variant is unchanged', () => {
    render(<SystemPromptDialog />);
    open({ startsSession: true });

    fireEvent.click(screen.getByRole('button', { name: 'Apply & start session' }));

    expect(setSystemPromptVariant).not.toHaveBeenCalled();
    expect(newSession).toHaveBeenCalledOnce();
  });

  it('explains itself and disables Apply when the server offers no variants', () => {
    render(<SystemPromptDialog />);
    open({ info: { current: 'default', chosen: true, variants: [] } });

    expect(
      screen.getByText('System prompt selection is not available on this server.'),
    ).toBeDefined();
    expect(screen.getByRole('button', { name: 'Apply' }).hasAttribute('disabled')).toBe(true);
  });

  it('treats any explicit open as the session’s one ask', () => {
    // The first-run effect in App.tsx opens the picker only while
    // `promptedThisSession` is false. If an explicit open did not set that
    // flag, the effect could fire on top of an already-open New Session picker
    // and reset `pickerStartsSession` to false — the session start would
    // vanish with no visible symptom.
    act(() => {
      useSystemPromptStore.getState().openPicker({ startsSession: true });
    });

    expect(useSystemPromptStore.getState().promptedThisSession).toBe(true);
    expect(useSystemPromptStore.getState().pickerStartsSession).toBe(true);
  });

  it('uses the first-run wording only until a variant has been chosen', () => {
    render(<SystemPromptDialog />);
    open({ info: { ...INFO, chosen: false } });

    expect(screen.getByText(/before your first message/)).toBeDefined();
  });
});
