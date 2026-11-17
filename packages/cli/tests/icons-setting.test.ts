import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/arg-parser.js';
import { applyIconsSetting } from '../src/boot/icons-setting.js';

describe('--icons / WSTACK_ICONS / config icons', () => {
  it('parses --icons as a value flag, in both spellings, without eating the prompt', () => {
    expect(parseArgs(['--icons', 'ascii', 'fix the bug']).flags['icons']).toBe('ascii');
    expect(parseArgs(['--icons=nerd']).flags['icons']).toBe('nerd');
    expect(parseArgs(['--icons', 'ascii', 'fix the bug']).positional).toEqual(['fix the bug']);
  });

  it('lets the flag beat the env var and the config', () => {
    const env: NodeJS.ProcessEnv = { WSTACK_ICONS: 'nerd' };
    expect(applyIconsSetting({ icons: 'ASCII' }, 'nerd', env)).toEqual({
      ok: true,
      icons: 'ascii',
    });
    expect(env['WSTACK_ICONS']).toBe('ascii');
  });

  it('lets the env var beat the config', () => {
    const env: NodeJS.ProcessEnv = { WSTACK_ICONS: 'nerd' };
    expect(applyIconsSetting({}, 'ascii', env)).toEqual({ ok: true, icons: 'nerd' });
    expect(env['WSTACK_ICONS']).toBe('nerd');
  });

  it('writes the config value into the env for the TUI and child processes', () => {
    const env: NodeJS.ProcessEnv = {};
    expect(applyIconsSetting({}, 'ascii', env)).toEqual({ ok: true, icons: 'ascii' });
    expect(env['WSTACK_ICONS']).toBe('ascii');
  });

  it('does not let config override an explicit legacy icon style or --ascii', () => {
    const env: NodeJS.ProcessEnv = { WRONGSTACK_TUI_ICON_STYLE: 'ascii' };
    expect(applyIconsSetting({}, 'nerd', env)).toEqual({ ok: true, icons: undefined });
    expect(env['WSTACK_ICONS']).toBeUndefined();
  });

  it('leaves everything unset when nothing is configured (auto)', () => {
    const env: NodeJS.ProcessEnv = {};
    expect(applyIconsSetting({}, undefined, env)).toEqual({ ok: true, icons: undefined });
    expect(applyIconsSetting({}, 'sparkles', env)).toEqual({ ok: true, icons: undefined });
    expect(env['WSTACK_ICONS']).toBeUndefined();
  });

  it('rejects a bad --icons value as a usage error', () => {
    const env: NodeJS.ProcessEnv = {};
    const bare = applyIconsSetting({ icons: true }, undefined, env);
    const typo = applyIconsSetting({ icons: 'nerdfont' }, undefined, env);
    expect(bare.ok).toBe(false);
    expect(typo).toEqual({
      ok: false,
      error: '--icons expects one of auto, nerd, ascii (got "nerdfont")',
    });
    expect(env['WSTACK_ICONS']).toBeUndefined();
  });
});
