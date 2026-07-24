import type { TelegramPluginConfig } from '../../src/config.js';
import { describe, expect, it } from 'vitest';
import { diffConfigKeys } from '../../src/config-classifier.js';

const baseConfig: TelegramPluginConfig = {
  botToken: 'test:token',
};

describe('P2.3 — atomic live-reconfigure classifier gate', () => {
  // P2.3 contract: a reconfigure plan that contains any
  // `restart-required` change must NOT be silently applied as live.
  // The classifier is the gate: a runtime that diff'd the previous
  // and next configs and sees any `restart-required` entry must
  // keep the old healthy bot (and surface the restart hint to the
  // operator) instead of trying to splice a partial hot-only swap.
  it('treats any restart-required change as a full-restart gate, not a partial live swap', () => {
    const previous: TelegramPluginConfig = {
      botToken: 'A',
      pollIntervalSec: 2,
      allowedUsers: ['u1'],
    };
    const next: TelegramPluginConfig = {
      botToken: 'B',
      pollIntervalSec: 5,
      allowedUsers: ['u1', 'u2'],
    };
    const diff = diffConfigKeys(previous, next);
    // botToken → restart-required (transport identity)
    // pollIntervalSec → hot (read on every poll tick)
    // allowedUsers → hot (re-evaluated per inbound)
    expect(diff).toEqual([
      { key: 'botToken', classification: 'restart-required' },
      { key: 'pollIntervalSec', classification: 'hot' },
      { key: 'allowedUsers', classification: 'hot' },
    ]);
    // The classifier gate contract: if ANY entry is restart-required,
    // a live reconfigure must keep the old runtime. This is the single
    // Boolean a runtime evaluates before swapping a hot-only patch.
    const requiresRestart = diff.some((d) => d.classification === 'restart-required');
    expect(requiresRestart).toBe(true);
  });

  it('emits zero entries for an empty diff (no change → no swap needed)', () => {
    const same: TelegramPluginConfig = { botToken: 'A', pollIntervalSec: 2 };
    expect(diffConfigKeys(same, same)).toEqual([]);
  });

  it('emits no duplicate keys when both sets overlap on a value-equal entry', () => {
    const previous: TelegramPluginConfig = { botToken: 'A', pollIntervalSec: 2 };
    const next: TelegramPluginConfig = { botToken: 'A', pollIntervalSec: 5 };
    const diff = diffConfigKeys(previous, next);
    expect(diff).toEqual([{ key: 'pollIntervalSec', classification: 'hot' }]);
  });
});

describe('diffConfigKeys', () => {
  it('reports no changes when both configs are identical', () => {
    expect(diffConfigKeys(baseConfig, baseConfig)).toEqual([]);
  });

  it('flags a changed hot key as hot', () => {
    const next: TelegramPluginConfig = { ...baseConfig, pollIntervalSec: 5 };
    expect(diffConfigKeys(baseConfig, next)).toEqual([
      { key: 'pollIntervalSec', classification: 'hot' },
    ]);
  });

  it('flags a changed restart-required key as restart-required', () => {
    const next: TelegramPluginConfig = { ...baseConfig, notifyChatId: 123 };
    expect(diffConfigKeys(baseConfig, next)).toEqual([
      { key: 'notifyChatId', classification: 'restart-required' },
    ]);
  });

  it('classifies a removed hot key as hot (every call re-reads the allowlist)', () => {
    const previous: TelegramPluginConfig = { ...baseConfig, allowedUsers: [1, 2] };
    const next: TelegramPluginConfig = { ...baseConfig };
    const diff = diffConfigKeys(previous, next);
    expect(diff).toEqual([{ key: 'allowedUsers', classification: 'hot' }]);
  });

  it('classifies an added hot key as hot (next call uses the new value)', () => {
    const previous: TelegramPluginConfig = { ...baseConfig };
    const next: TelegramPluginConfig = { ...baseConfig, maxMessageLength: 8000 };
    const diff = diffConfigKeys(previous, next);
    expect(diff).toEqual([{ key: 'maxMessageLength', classification: 'hot' }]);
  });

  it('treats array contents element-wise (a reorder is a change)', () => {
    const previous: TelegramPluginConfig = { ...baseConfig, allowedChats: [1, 2, 3] };
    const next: TelegramPluginConfig = { ...baseConfig, allowedChats: [3, 2, 1] };
    expect(diffConfigKeys(previous, next)).toEqual([
      { key: 'allowedChats', classification: 'hot' },
    ]);
  });

  it('reports multiple changes in a single diff', () => {
    const previous: TelegramPluginConfig = {
      ...baseConfig,
      pollIntervalSec: 2,
      notifyChatId: 100,
      allowedChats: [1],
    };
    const next: TelegramPluginConfig = {
      ...baseConfig,
      pollIntervalSec: 5,
      notifyChatId: 200,
      allowedChats: [1, 2],
    };
    const diff = diffConfigKeys(previous, next);
    expect(diff).toEqual([
      { key: 'pollIntervalSec', classification: 'hot' },
      { key: 'notifyChatId', classification: 'restart-required' },
      { key: 'allowedChats', classification: 'hot' },
    ]);
  });
});
