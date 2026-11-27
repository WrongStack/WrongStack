import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IntegrationsSection } from '../../src/components/SettingsPanel/IntegrationsSection.js';
import { useLocalPrefs } from '../../src/stores/local-prefs.js';

/**
 * The Telegram half of the Integrations panel.
 *
 * `pollIntervalSec` and `notifyChatId` are the two settings `/telegram-settings`
 * exposes that the panel could not save before. The important behaviour is
 * *when* the write happens: a rejected `prefs.update` fails the WHOLE payload,
 * so both fields hold a draft and commit on blur / Enter instead of on every
 * keystroke — otherwise typing "-1" or "1." would send an invalid value, get
 * rejected, and silently keep the old setting while the input still looks new.
 */

beforeEach(() => {
  useLocalPrefs.setState({ tgConfigured: true, tgPollIntervalSec: 2, tgChatId: '' });
});

afterEach(() => cleanup());

// The webui test env mounts the real (English) translation resources rather
// than echoing `ns:key`, so these are matched as the user sees them — the
// same approach tests/components/tool-coach-setting.test.tsx uses.
const pollInput = () => screen.getByLabelText(/polling interval/i) as HTMLInputElement;
const chatInput = () => screen.getByLabelText(/notification chat/i) as HTMLInputElement;
/** jsdom only fires blur for a focused element, so the Enter path needs one. */
const pressEnter = (input: HTMLInputElement) => {
  input.focus();
  fireEvent.keyDown(input, { key: 'Enter' });
};

describe('IntegrationsSection — Telegram settings', () => {
  it('hides the Telegram fields until a bot token is configured', () => {
    useLocalPrefs.setState({ tgConfigured: false });
    render(<IntegrationsSection syncPref={vi.fn()} />);
    expect(screen.queryByLabelText(/polling interval/i)).toBeNull();
  });

  it('seeds both fields from the server-provided prefs', () => {
    useLocalPrefs.setState({ tgPollIntervalSec: 7, tgChatId: '-100123' });
    render(<IntegrationsSection syncPref={vi.fn()} />);
    expect(pollInput().value).toBe('7');
    expect(chatInput().value).toBe('-100123');
  });

  it('commits the poll interval on blur, not on keystroke', () => {
    const syncPref = vi.fn();
    render(<IntegrationsSection syncPref={syncPref} />);
    fireEvent.change(pollInput(), { target: { value: '15' } });
    expect(syncPref).not.toHaveBeenCalled();
    fireEvent.blur(pollInput());
    expect(syncPref).toHaveBeenCalledWith('tgPollIntervalSec', 15);
  });

  it('commits the chat ID on Enter', () => {
    const syncPref = vi.fn();
    render(<IntegrationsSection syncPref={syncPref} />);
    fireEvent.change(chatInput(), { target: { value: '12345' } });
    pressEnter(chatInput());
    expect(syncPref).toHaveBeenCalledWith('tgChatId', '12345');
  });

  it('trims a pasted chat ID before sending it', () => {
    const syncPref = vi.fn();
    render(<IntegrationsSection syncPref={syncPref} />);
    fireEvent.change(chatInput(), { target: { value: '  98765  ' } });
    fireEvent.blur(chatInput());
    expect(syncPref).toHaveBeenCalledWith('tgChatId', '98765');
  });

  it('clears the chat ID when the field is emptied', () => {
    const syncPref = vi.fn();
    useLocalPrefs.setState({ tgChatId: '12345' });
    render(<IntegrationsSection syncPref={syncPref} />);
    fireEvent.change(chatInput(), { target: { value: '' } });
    fireEvent.blur(chatInput());
    expect(syncPref).toHaveBeenCalledWith('tgChatId', '');
  });

  // A half-typed "-" or "1." is transient, not a user error; sending it would
  // trip the server's whole-payload rejection.
  it.each(['-', '1.', 'abc', '1e4', '0', '-0'])(
    'blocks the invalid chat id %j without sending it',
    (value) => {
      const syncPref = vi.fn();
      render(<IntegrationsSection syncPref={syncPref} />);
      fireEvent.change(chatInput(), { target: { value } });
      fireEvent.blur(chatInput());
      expect(syncPref).not.toHaveBeenCalled();
      expect(chatInput().getAttribute('aria-invalid')).toBe('true');
      const alert = screen.getByRole('alert');
      expect(chatInput().getAttribute('aria-describedby')).toBe(alert.id);
    },
  );

  it.each(['0', '61', '-1', '2.9'])(
    'reverts the out-of-range poll interval %j instead of sending it',
    (value) => {
      const syncPref = vi.fn();
      render(<IntegrationsSection syncPref={syncPref} />);
      fireEvent.change(pollInput(), { target: { value } });
      fireEvent.blur(pollInput());
      expect(syncPref).not.toHaveBeenCalled();
      expect(pollInput().value).toBe('2');
    },
  );

  it('does not re-send an unchanged value', () => {
    const syncPref = vi.fn();
    render(<IntegrationsSection syncPref={syncPref} />);
    fireEvent.blur(pollInput());
    fireEvent.blur(chatInput());
    expect(syncPref).not.toHaveBeenCalled();
  });
});
