/**
 * Coverage for core/src/storage/config-loader/validation.ts
 */

import type { ContextConfig } from '@wrongstack/contracts/types/config/context';
import { ConfigError } from '@wrongstack/contracts/types/errors';
import { describe, expect, it } from 'vitest';
import {
  validateConfigBehavior,
  validateConfigIdentity,
} from '../../src/storage/config-loader/validation.js';

function validConfig(): { version: 1; context: ContextConfig } {
  return {
    version: 1 as const,
    context: {
      warnThreshold: 0.5,
      softThreshold: 0.75,
      hardThreshold: 0.9,
      preserveK: 3,
      eliseThreshold: 0.35,
    },
  };
}

describe('validateConfigBehavior', () => {
  it('accepts a valid config', () => {
    const cfg = validConfig();
    expect(() => validateConfigBehavior(cfg, () => {})).not.toThrow();
  });

  it('throws on unsupported version', () => {
    expect(() => validateConfigBehavior({ ...validConfig(), version: 2 } as any, () => {})).toThrow(
      ConfigError,
    );
  });

  it('throws on missing context section', () => {
    const cfg = { ...validConfig(), context: undefined };
    expect(() => validateConfigBehavior(cfg as any, () => {})).toThrow(ConfigError);
  });

  it('names and drops hooks registered under an unknown event, keeping the rest', () => {
    const warnings: Array<{ msg: string; ctx?: Record<string, unknown> | undefined }> = [];
    const cfg = {
      ...validConfig(),
      hooks: {
        PreCompact: [{ command: 'backup.sh' }],
        SessionEnd: [{ command: 'bye.sh' }],
        PreCompacts: [{ command: 'typo.sh' }],
      },
    };

    validateConfigBehavior(cfg as any, (msg, ctx) => warnings.push({ msg, ctx }));

    expect(Object.keys(cfg.hooks)).toEqual(['PreCompact', 'SessionEnd']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.msg).toContain('"PreCompacts"');
    expect(warnings[0]?.ctx).toMatchObject({
      event: 'config.unknown_hook_event',
      hookEvent: 'PreCompacts',
    });
  });

  it('throws when warnThreshold is not a number', () => {
    const cfg = validConfig();
    cfg.context.warnThreshold = 'invalid' as any;
    expect(() => validateConfigBehavior(cfg, () => {})).toThrow(ConfigError);
  });

  it('throws when softThreshold is NaN', () => {
    const cfg = validConfig();
    cfg.context.softThreshold = NaN;
    expect(() => validateConfigBehavior(cfg, () => {})).toThrow(ConfigError);
  });

  it('throws when hardThreshold is Infinity', () => {
    const cfg = validConfig();
    cfg.context.hardThreshold = Infinity;
    expect(() => validateConfigBehavior(cfg, () => {})).toThrow(ConfigError);
  });

  it('throws when warn >= soft', () => {
    const cfg = validConfig();
    cfg.context.warnThreshold = 0.8;
    cfg.context.softThreshold = 0.75;
    expect(() => validateConfigBehavior(cfg, () => {})).toThrow(ConfigError);
  });

  it('throws when soft >= hard', () => {
    const cfg = validConfig();
    cfg.context.softThreshold = 0.9;
    cfg.context.hardThreshold = 0.9;
    expect(() => validateConfigBehavior(cfg, () => {})).toThrow(ConfigError);
  });

  it('warns and resets unknown context.mode', () => {
    const cfg = validConfig();
    cfg.context.mode = 'unknown-mode' as any;
    let warnCalled = false;
    validateConfigBehavior(cfg, (msg) => {
      if (msg.includes('unknown context.mode')) warnCalled = true;
    });
    expect(warnCalled).toBe(true);
  });

  // The previous body set `mode = 'balanced'` — already a valid id — and then
  // asserted `toBeDefined()`, which held before validate even ran. It exercised
  // the no-op path and could only fail if validate DELETED the field. The real
  // normalisation is the deprecated-alias rewrite, pinned here with its
  // neighbours so each branch is distinguishable.
  it('normalizes a deprecated context.mode alias to its current id, silently', () => {
    const cfg = validConfig();
    cfg.context.mode = 'archival' as any;
    const warnings: string[] = [];
    validateConfigBehavior(cfg, (w) => warnings.push(String(w)));
    expect(cfg.context.mode).toBe('balanced');
    // A known alias is a rename, not a mistake — it must not warn.
    expect(warnings).toEqual([]);
  });

  it.each([['balanced'], ['frugal'], ['deep']])(
    'preserves the valid context.mode %j unchanged',
    (mode) => {
      const cfg = validConfig();
      cfg.context.mode = mode as any;
      const warnings: string[] = [];
      validateConfigBehavior(cfg, (w) => warnings.push(String(w)));
      expect(cfg.context.mode).toBe(mode);
      expect(warnings).toEqual([]);
    },
  );

  // Ids are case-sensitive: `BALANCED` is NOT normalised case-insensitively, it
  // is an unknown id that happens to fall back to the same default. Pinned so a
  // reader does not mistake that coincidence for case folding.
  it.each([['nonsense'], ['BALANCED']])(
    'falls back to balanced and warns for unknown %j',
    (mode) => {
      const cfg = validConfig();
      cfg.context.mode = mode as any;
      const warnings: string[] = [];
      validateConfigBehavior(cfg, (w) => warnings.push(String(w)));
      expect(cfg.context.mode).toBe('balanced');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(`unknown context.mode "${mode}"`);
    },
  );
});

describe('validateConfigIdentity', () => {
  it('throws when no provider configured', () => {
    expect(() => validateConfigIdentity({ version: 1 } as any)).toThrow(ConfigError);
  });

  it('throws when no model configured', () => {
    expect(() => validateConfigIdentity({ version: 1, provider: { id: 'openai' } } as any)).toThrow(
      ConfigError,
    );
  });

  it('does not throw when provider and model are set', () => {
    expect(() =>
      validateConfigIdentity({ version: 1, provider: { id: 'openai' }, model: 'gpt-4o' } as any),
    ).not.toThrow();
  });
});
