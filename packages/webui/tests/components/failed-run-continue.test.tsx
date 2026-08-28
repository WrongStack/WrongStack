import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * FailedRunContinue — the Continue button beside a failed assistant message.
 *
 * Contract:
 * - Countdown auto-fires a continuation send: 30s for expensive report
 *   failures (Chimera), 15s for everything else — but ONLY for fresh
 *   failures (a stale transcript's button stays manual).
 * - Cancel/Stop disarms the auto-fire; the manual button stays.
 * - A run the user already restarted disarms the auto-fire (isLoading gate).
 */

const sendMessage = vi.fn();
vi.mock('@/lib/ws-client', () => ({
  getWSClient: () => ({ isConnected: true, sendMessage }),
}));

vi.mock('@/i18n', () => {
  const t = (k: string, d?: string | ({ defaultValue?: string } & Record<string, unknown>)) => {
    if (typeof d === 'string') return d;
    let out = d?.defaultValue ?? k;
    for (const [key, value] of Object.entries(d ?? {})) {
      if (key === 'defaultValue') continue;
      out = out.replaceAll(`{{${key}}}`, String(value));
    }
    return out;
  };
  return { useAppTranslation: () => ({ t }), i18n: { t } };
});

// The shared auto-submit loop guard is MessageBubble-level behaviour with
// cross-test state; this suite pins the countdown/routing contract only.
vi.mock('@/stores/auto-submit-streak.js', () => ({
  useAutoSubmitStreak: () => ({
    canAutoSubmit: () => true,
    recordPrompt: () => true,
    recordAutoSubmit: vi.fn(),
    capWarned: false,
  }),
}));

const { FailedRunContinue, autoTriggerMsFor } = await import(
  '../../src/components/MessageBubble/FailedRunContinue'
);
const { useChatStore } = await import('../../src/stores');
const { useChatLanes } = await import('../../src/stores/chat-lanes');

function renderWith(opts: { text?: string; timestamp?: number } = {}) {
  return render(
    <FailedRunContinue
      text={opts.text ?? 'Run failed: boom'}
      timestamp={opts.timestamp ?? Date.now()}
    />,
  );
}

const continueButton = () => screen.getByRole('button', { name: /Continue/ });

beforeEach(() => {
    vi.useFakeTimers();
    // Fresh lanes: a prior test's setLoading(true) must not block this
    // suite's fire() paths (they early-return on a live isLoading).
    useChatLanes.setState({ lanes: {}, activeSessionId: '__unbound__' });
    sendMessage.mockClear();
  });

afterEach(() => {
  vi.useRealTimers();
});

describe('autoTriggerMsFor', () => {
  it('gives Chimera-style report failures the long 30s window', () => {
    expect(autoTriggerMsFor('Chimera review: 2 findings')).toBe(30_000);
  });

  it('gives plain failures the default 15s window', () => {
    expect(autoTriggerMsFor('Agent is already processing a request.')).toBe(15_000);
  });
});

describe('countdown', () => {
  it('counts down from 30s on a Chimera failure and auto-fires the continuation', async () => {
    renderWith({ text: 'Chimera review: 2 findings' });

    expect(continueButton().textContent).toContain('30s');
    // One 1s step per flush — a single 30s jump only fires the first tick,
    // because React re-schedules the next timeout in the effect afterwards.
    for (let step = 0; step < 30; step += 1) {
      await act(async () => {
        vi.advanceTimersByTime(1_000);
      });
    }

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[0]).toContain('continue from where it stopped');
    // Fired once — the button row is gone after the continuation is sent.
    expect(screen.queryByRole('button', { name: /Continue/ })).toBeNull();
  });

  it('counts down from 15s on a plain failure', () => {
    renderWith();
    expect(continueButton().textContent).toContain('15s');
  });

  it('cancel disarms the auto-fire but keeps the manual button', async () => {
    renderWith();
    fireEvent.click(screen.getByRole('button', { name: /Cancel/ }));

    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(continueButton().textContent).not.toContain('s');
  });

  it('a manual click fires immediately without waiting for the countdown', () => {
    renderWith();
    fireEvent.click(continueButton());
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});

describe('freshness gate', () => {
  it('a stale failure keeps the button manual — no countdown, no auto-fire', async () => {
    renderWith({ timestamp: Date.now() - 10 * 60_000 });

    expect(continueButton().textContent).not.toContain('s');
    expect(screen.queryByRole('button', { name: /Cancel/ })).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(sendMessage).not.toHaveBeenCalled();

    fireEvent.click(continueButton());
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});
