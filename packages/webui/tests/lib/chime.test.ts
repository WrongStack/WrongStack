// @vitest-environment jsdom
// These helpers touch `window` — the package-local vitest config runs all
// webui tests under jsdom, but the ROOT config (pnpm test) defaults to the
// node environment; this pragma keeps the file green from both entries.
import { beforeEach, describe, expect, it, vi } from 'vitest';

function installAudioMock() {
  const oscillators: Array<{
    frequency: { value: number };
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  }> = [];

  class MockAudioContext {
    currentTime = 10;
    destination = {};

    createOscillator() {
      const osc = {
        type: 'sine',
        frequency: { value: 0 },
        connect: vi.fn(() => ({ connect: vi.fn() })),
        start: vi.fn(),
        stop: vi.fn(),
      };
      oscillators.push(osc);
      return osc;
    }

    createGain() {
      return {
        gain: {
          setValueAtTime: vi.fn(),
          linearRampToValueAtTime: vi.fn(),
          exponentialRampToValueAtTime: vi.fn(),
        },
        connect: vi.fn(() => ({})),
      };
    }
  }

  Object.defineProperty(window, 'AudioContext', {
    configurable: true,
    value: MockAudioContext,
  });

  return { oscillators };
}

describe('chime helpers', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Object.defineProperty(window, 'AudioContext', {
      configurable: true,
      value: undefined,
    });
  });

  it('does nothing when Web Audio is unavailable', async () => {
    const { playCompletionChime, playPermissionChime } = await import('@/lib/chime');

    expect(() => playCompletionChime()).not.toThrow();
    expect(() => playPermissionChime()).not.toThrow();
  });

  it('plays the two-note completion chime', async () => {
    const { oscillators } = installAudioMock();
    const { playCompletionChime } = await import('@/lib/chime');

    playCompletionChime();

    expect(oscillators.map((o) => o.frequency.value)).toEqual([659.25, 880]);
    expect(oscillators.every((o) => o.start.mock.calls.length === 1)).toBe(true);
    expect(oscillators.every((o) => o.stop.mock.calls.length === 1)).toBe(true);
  });

  it('plays the three-note permission chime', async () => {
    const { oscillators } = installAudioMock();
    const { playPermissionChime } = await import('@/lib/chime');

    playPermissionChime();

    expect(oscillators.map((o) => o.frequency.value)).toEqual([523.25, 659.25, 783.99]);
  });

  it('catches AudioContext constructor throw', async () => {
    // Replace AudioContext with a class that throws on construction,
    // covering the catch block at chime.ts:26
    const OrigAudioContext = window.AudioContext;
    Object.defineProperty(window, 'AudioContext', {
      configurable: true,
      value: class ThrowsAudioContext {
        constructor() {
          throw new Error('AudioContext unavailable');
        }
      },
    });
    vi.resetModules();
    const { playCompletionChime } = await import('@/lib/chime');
    expect(() => playCompletionChime()).not.toThrow();
    // Restore original so subsequent tests aren't affected
    Object.defineProperty(window, 'AudioContext', {
      configurable: true,
      value: OrigAudioContext,
    });
  });
});
