import type { Config } from '@wrongstack/core/types';
import { describe, expect, it } from 'vitest';
import {
  applySimpleUiFullAutoProfile,
  configureSimpleUiRuntimeContext,
  isSimpleUiFullAuto,
} from '../src/boot/simpleui-full-auto.js';

describe('SimpleUI full-auto launch profile', () => {
  it('overrides ordinary runtime limits while preserving safety configuration', () => {
    const config = Object.freeze({
      yolo: false,
      autonomy: { defaultMode: 'off' },
      tools: Object.freeze({
        disabledTools: ['bash', 'write'],
        restrictToProjectRoot: true,
        exec: { deny: ['shutdown'] },
      }),
    }) as Config;
    const flags: Record<string, string | boolean> = {
      simpleui: true,
      webui: true,
      'full-auto': true,
      'no-director': true,
      'no-autonomy': true,
    };

    const resolved = applySimpleUiFullAutoProfile(config, flags);

    expect(resolved).not.toBe(config);
    expect(resolved.yolo).toBe(true);
    expect(resolved.tools).toMatchObject({
      disabledTools: [],
      restrictToProjectRoot: true,
      exec: { deny: ['shutdown'] },
    });
    expect(resolved.autonomy?.defaultMode).toBe('off');
    expect(flags).toMatchObject({
      yolo: true,
      director: true,
      'no-director': false,
      autonomy: 'auto',
      'no-autonomy': false,
    });
  });

  it('leaves config and flags untouched when the profile is absent', () => {
    const config = { yolo: false, tools: { disabledTools: ['bash'] } } as unknown as Config;
    const flags = { simpleui: true, webui: true };

    expect(applySimpleUiFullAutoProfile(config, flags)).toBe(config);
    expect(flags).toEqual({ simpleui: true, webui: true });
  });

  it('does not apply outside the SimpleUI surface', () => {
    const config = { yolo: false, tools: { disabledTools: ['bash'] } } as unknown as Config;
    const flags = { webui: true, 'full-auto': true };

    expect(applySimpleUiFullAutoProfile(config, flags)).toBe(config);
    expect(flags).toEqual({ webui: true, 'full-auto': true });
  });

  it('preserves project-root containment across full-auto YOLO', () => {
    const config = {
      tools: { restrictToProjectRoot: true, disabledTools: [] },
    } as unknown as Config;
    const flags = { simpleui: true, 'full-auto': true } as Record<string, string | boolean>;

    const resolved = applySimpleUiFullAutoProfile(config, flags);

    expect(resolved.yolo).toBe(true);
    expect(resolved.tools.restrictToProjectRoot).toBe(true);
  });

  it('preserves exec deny list across full-auto YOLO', () => {
    const config = {
      tools: {
        disabledTools: [],
        exec: { deny: ['shutdown', 'rm -rf', 'mkfs'] },
      },
    } as unknown as Config;
    const flags = { simpleui: true, 'full-auto': true } as Record<string, string | boolean>;

    const resolved = applySimpleUiFullAutoProfile(config, flags);

    expect(resolved.yolo).toBe(true);
    expect(resolved.tools.exec?.deny).toEqual(['shutdown', 'rm -rf', 'mkfs']);
  });

  it('returns a deeply frozen config when the profile applies', () => {
    const config = {
      tools: { disabledTools: ['bash'] },
    } as unknown as Config;
    const flags = { simpleui: true, 'full-auto': true } as Record<string, string | boolean>;

    const resolved = applySimpleUiFullAutoProfile(config, flags);

    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.tools)).toBe(true);
    expect(() => {
      (resolved as { yolo: boolean }).yolo = false;
    }).toThrow(TypeError);
    expect(() => {
      (resolved.tools as { disabledTools: string[] }).disabledTools = ['netcat'];
    }).toThrow(TypeError);
  });

  it('does not mutate flags outside the SimpleUI keys when profile is absent', () => {
    const config = { tools: { disabledTools: [] } } as unknown as Config;
    const flags = {
      simpleui: true,
      webui: true,
      unrelated: 'kept',
      yolo: false,
    } as Record<string, string | boolean>;

    applySimpleUiFullAutoProfile(config, flags);

    expect(flags).toEqual({
      simpleui: true,
      webui: true,
      unrelated: 'kept',
      yolo: false,
    });
  });
});

describe('isSimpleUiFullAuto predicate', () => {
  it('is true only when both simpleui and full-auto are exactly `true`', () => {
    expect(isSimpleUiFullAuto({ simpleui: true, 'full-auto': true })).toBe(true);
    expect(
      isSimpleUiFullAuto({ simpleui: true, 'full-auto': true, extra: 1 as unknown as boolean }),
    ).toBe(true);
  });

  it('rejects non-boolean truthy values for simpleui', () => {
    expect(isSimpleUiFullAuto({ simpleui: 1 as unknown as boolean, 'full-auto': true })).toBe(
      false,
    );
    expect(isSimpleUiFullAuto({ simpleui: 'true' as unknown as boolean, 'full-auto': true })).toBe(
      false,
    );
    expect(isSimpleUiFullAuto({ simpleui: 'TRUE' as unknown as boolean, 'full-auto': true })).toBe(
      false,
    );
    expect(
      isSimpleUiFullAuto({
        simpleui: 1 as unknown as boolean,
        'full-auto': 'true' as unknown as boolean,
      }),
    ).toBe(false);
  });

  it('rejects when only one of the two flags is true', () => {
    expect(isSimpleUiFullAuto({ simpleui: true, 'full-auto': false })).toBe(false);
    expect(isSimpleUiFullAuto({ simpleui: false, 'full-auto': true })).toBe(false);
    expect(isSimpleUiFullAuto({ simpleui: true })).toBe(false);
    expect(isSimpleUiFullAuto({ 'full-auto': true })).toBe(false);
  });

  it('rejects when both flags are missing', () => {
    expect(isSimpleUiFullAuto({})).toBe(false);
    expect(isSimpleUiFullAuto({ webui: true })).toBe(false);
  });
});

describe('SimpleUI runtime context profile', () => {
  it('keeps coordination telemetry in background mode for every SimpleUI launch', () => {
    const meta: Record<string, unknown> = {};

    configureSimpleUiRuntimeContext(meta, { simpleui: true, webui: true });

    expect(meta).toEqual({
      source: 'webui',
      surface: 'simpleui',
      coordinationContextMode: 'background',
    });
  });

  it('does not change other surfaces', () => {
    const meta: Record<string, unknown> = { source: 'cli' };
    configureSimpleUiRuntimeContext(meta, { webui: true });
    expect(meta).toEqual({ source: 'cli' });
  });

  it('does not apply when simpleui flag is a non-boolean truthy value', () => {
    const meta: Record<string, unknown> = {};
    configureSimpleUiRuntimeContext(meta, {
      simpleui: 1 as unknown as boolean,
      webui: true,
    });
    expect(meta).toEqual({});
  });
});
