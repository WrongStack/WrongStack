import { describe, expect, it } from 'vitest';
import {
  buildWebuiCommandFallbackScript,
  normalizeDesktopWebuiCommand,
} from '../src/main/webui-command-bridge.js';

describe('desktop WebUI command bridge', () => {
  it('accepts terminal commands used by the desktop shell', () => {
    expect(normalizeDesktopWebuiCommand({ terminal: true })).toEqual({ terminal: true });
    expect(normalizeDesktopWebuiCommand({ terminal: 'toggle' })).toEqual({ terminal: 'toggle' });
    expect(normalizeDesktopWebuiCommand({ terminal: 'new' })).toEqual({ terminal: 'new' });
  });

  it('rejects empty and invalid terminal commands', () => {
    expect(normalizeDesktopWebuiCommand({})).toBeNull();
    expect(normalizeDesktopWebuiCommand({ terminal: 'open' })).toBeNull();
    expect(normalizeDesktopWebuiCommand({ terminal: 1 })).toBeNull();
  });

  it('accepts the unified SDD hub view and rejects removed SDD view ids', () => {
    expect(normalizeDesktopWebuiCommand({ view: 'sddhub' })).toEqual({ view: 'sddhub' });
    expect(normalizeDesktopWebuiCommand({ view: 'sddboard' })).toBeNull();
    expect(normalizeDesktopWebuiCommand({ view: 'sddwizard' })).toBeNull();
    expect(normalizeDesktopWebuiCommand({ view: 'specs' })).toBeNull();
  });

  it('accepts only supported preference commands', () => {
    expect(normalizeDesktopWebuiCommand({ pref: { key: 'yolo', toggle: true } })).toEqual({
      pref: { key: 'yolo', toggle: true },
    });
    expect(
      normalizeDesktopWebuiCommand({ pref: { key: 'contextAutoCompact', value: false } }),
    ).toEqual({
      pref: { key: 'contextAutoCompact', value: false },
    });
    expect(normalizeDesktopWebuiCommand({ pref: { key: 'yolo' } })).toBeNull();
    expect(normalizeDesktopWebuiCommand({ pref: { key: 'provider', toggle: true } })).toBeNull();
  });

  it('builds a DOM fallback event without raw HTML breakouts', () => {
    const script = buildWebuiCommandFallbackScript({
      terminal: 'new',
      requestId: 'req-</script><img>',
    });

    expect(script).toContain('wrongstack:desktop-command');
    expect(script).toContain('"terminal":"new"');
    expect(script).toContain('\\u003c/script>');
    expect(script).not.toContain('</script>');
  });
});
