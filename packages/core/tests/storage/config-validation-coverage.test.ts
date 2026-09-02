/**
 * Coverage for core/src/storage/config-loader/validation.ts
 */
import { describe, expect, it } from 'vitest';
import {
  validateConfigBehavior,
  validateConfigIdentity,
} from '../../src/storage/config-loader/validation.js';
import { ConfigError } from '../../src/types/errors.js';
import type { ContextConfig } from '../../src/types/config/context.js';

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

  it('normalizes known context.mode', () => {
    const cfg = validConfig();
    cfg.context.mode = 'balanced' as any;
    validateConfigBehavior(cfg, () => {});
    expect(cfg.context.mode).toBeDefined();
  });
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
