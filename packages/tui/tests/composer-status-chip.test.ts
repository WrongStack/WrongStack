import { describe, expect, it } from 'vitest';
import {
  type ComposerStatus,
  composerStatusFromState,
  composerStatusReservedWidth,
} from '../src/components/composer-status-chip.js';
import { displayWidth } from '../src/terminal-width.js';

describe('composerStatusFromState (descriptor mapping)', () => {
  const base = {
    status: 'idle' as const,
    confirmCount: 0,
    queueCount: 0,
    thinkingWord: 'thinking',
    fleetRunning: 0,
  };

  it('prioritizes an open confirm panel over everything else', () => {
    const s = composerStatusFromState({
      ...base,
      status: 'running',
      confirmCount: 2,
      queueCount: 3,
    });
    expect(s).toEqual({ kind: 'confirm' });
  });

  it('maps running/streaming to the animated working word', () => {
    expect(composerStatusFromState({ ...base, status: 'running', thinkingWord: 'cooking' })).toEqual(
      { kind: 'working', word: 'cooking' },
    );
    expect(composerStatusFromState({ ...base, status: 'streaming', thinkingWord: 'musing' })).toEqual(
      { kind: 'working', word: 'musing' },
    );
  });

  it('maps aborting ahead of a non-empty queue', () => {
    expect(composerStatusFromState({ ...base, status: 'aborting', queueCount: 4 })).toEqual({
      kind: 'aborting',
    });
  });

  it('surfaces a queued count when idle with pending input', () => {
    expect(composerStatusFromState({ ...base, queueCount: 5 })).toEqual({ kind: 'queued', count: 5 });
  });

  it('falls back to idle, carrying the background fleet count', () => {
    expect(composerStatusFromState({ ...base })).toEqual({ kind: 'idle', fleetRunning: 0 });
    expect(composerStatusFromState({ ...base, fleetRunning: 3 })).toEqual({
      kind: 'idle',
      fleetRunning: 3,
    });
  });
});

describe('composerStatusReservedWidth (stable slot geometry)', () => {
  it('reserves spinner + space + word + widest-dots for working (frame-independent)', () => {
    // 1 (spinner) + 1 (space) + w(word) + 3 (widest "..." frame)
    expect(composerStatusReservedWidth({ kind: 'working', word: 'cooking' })).toBe(
      displayWidth('cooking') + 5,
    );
  });

  it('matches the static label width for the flat states', () => {
    const cases: Array<[ComposerStatus, string]> = [
      [{ kind: 'confirm' }, 'CONFIRM'],
      [{ kind: 'aborting' }, 'aborting…'],
      [{ kind: 'queued', count: 12 }, 'queued 12'],
      [{ kind: 'idle', fleetRunning: 0 }, 'idle'],
      [{ kind: 'idle', fleetRunning: 4 }, 'agents >4'],
    ];
    for (const [status, label] of cases) {
      expect(composerStatusReservedWidth(status)).toBe(displayWidth(label));
    }
  });
});
