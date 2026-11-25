import { describe, expect, it } from 'vitest';
import { formatAcpAgentList } from '../src/portable-commands/acp-agent-list.js';

// Registry metadata comes from a remote JSON document and local `--version`
// output comes from whatever binary is on PATH. Neither may drive the terminal.
const OSC_TITLE = '\u001b]0;pwned\u0007';
const CLEAR = '\u001b[2J';

describe('formatAcpAgentList terminal safety', () => {
  it('strips escape sequences from registry and local-CLI fields', () => {
    const text = formatAcpAgentList({
      live: {
        fetchedAt: '2026-11-25T12:00:00.000Z',
        byId: {
          evil: { command: 'evil-agent-not-on-path', args: [] },
          gone: { command: 'npx', args: ['-y', 'gone-agent'] },
        },
        agents: [
          {
            id: 'evil',
            displayName: `Evil${CLEAR}Agent`,
            acp: { command: 'evil-agent-not-on-path', args: [] },
            registry: {
              version: `1.0.0${OSC_TITLE}`,
              archive: `https://example.test/a.zip${CLEAR}\r`,
            },
          },
          {
            id: 'gone',
            displayName: 'Gone',
            acp: { command: 'npx', args: ['-y', 'gone-agent'] },
            registry: { quarantineReason: `bad${OSC_TITLE}` },
          },
        ] as never,
      },
      detected: [
        {
          id: 'extra-cli',
          displayName: 'Extra',
          installed: true,
          version: `9.9.9${CLEAR}`,
        },
      ] as never,
    });

    expect(text).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u);
    expect(text).toContain('[registry 1.0.0]');
    expect(text).toContain('https://example.test/a.zip');
    expect(text).toContain('upstream quarantine: bad');
    expect(text).toContain('9.9.9');
  });

  it('strips escape sequences from the bundled-catalog listing', () => {
    const text = formatAcpAgentList({
      live: null,
      detected: [
        { id: 'a', displayName: `A${CLEAR}`, installed: true, version: `1${OSC_TITLE}` },
        { id: 'b', displayName: 'B', installed: false, reason: `missing${CLEAR}` },
      ] as never,
    });
    expect(text).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u);
    expect(text).toContain('missing');
  });
});
