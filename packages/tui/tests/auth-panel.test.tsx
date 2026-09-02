import { describe, expect, it } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { AuthPanel, isAuthFlowUrlLine, latestAuthFlowUrl } from '../src/components/auth-panel.js';
import { AUTH_PANEL_INITIAL, type AuthPanelState } from '../src/components/auth-panel-model.js';
import { renderRealTty, settle } from './helpers/real-tty.js';

function panel(overrides: Partial<AuthPanelState> = {}): AuthPanelState {
  return { ...AUTH_PANEL_INITIAL, open: true, ...overrides };
}

function frameOf(state: AuthPanelState): string {
  const { lastFrame, unmount } = render(React.createElement(AuthPanel, { panel: state }));
  const frame = lastFrame() ?? '';
  unmount();
  return frame;
}

/**
 * The panel's controller sets `hint`/`confirm`/`input` for every direct action,
 * but none of the three were rendered — so setting an active key, deleting a
 * key, and confirming a provider removal all happened with no visible text.
 * These tests pin that each one reaches the frame.
 */
describe('AuthPanel feedback rendering', () => {
  it('renders the hint so direct-action results and errors are visible', () => {
    expect(frameOf(panel({ hint: '✓ Active key → work' }))).toContain('Active key → work');
    expect(frameOf(panel({ hint: '✗ Catalog unavailable: offline' }))).toContain(
      'Catalog unavailable: offline',
    );
  });

  it('renders the confirm question, not just a y/n legend', () => {
    const frame = frameOf(
      panel({
        view: 'provider',
        providerId: 'anthropic',
        confirm: {
          question: 'Remove provider "anthropic" and 2 key(s)?',
          action: { kind: 'remove-provider', providerId: 'anthropic' },
        },
      }),
    );
    expect(frame).toContain('Remove provider "anthropic" and 2 key(s)?');
  });

  it('renders the masked prompt in list view, where slash-command secret prompts open', () => {
    const frame = frameOf(
      panel({ view: 'list', input: { label: 'API key:', masked: true, draft: 'sk-abc' } }),
    );
    expect(frame).toContain('API key:');
    expect(frame).toContain('••••••');
    expect(frame).not.toContain('sk-abc');
  });

  it('shows an empty state instead of a bare action list when nothing is configured', () => {
    expect(frameOf(panel({ view: 'list', providers: [] }))).toContain('No providers configured');
    expect(frameOf(panel({ view: 'list', providers: [], busy: true }))).toContain('Loading');
  });
});

describe('AuthPanel flow URL rendering helpers', () => {
  it('recognizes standalone OAuth URLs so the TUI can wrap instead of truncate them', () => {
    expect(
      isAuthFlowUrlLine(
        'https://auth.openai.com/oauth/authorize?response_type=code&client_id=x&state=y',
      ),
    ).toBe(true);
    expect(isAuthFlowUrlLine('  http://localhost:1455/auth/callback?code=abc&state=xyz  ')).toBe(
      true,
    );
  });

  it('recognizes OSC 8 terminal-hyperlink wrapped URLs', () => {
    const osc8 =
      '\x1b]8;;https://auth.openai.com/oauth/authorize?response_type=code&client_id=x\x1b\\' +
      'https://auth.openai.com/oauth/authorize?response_type=code&client_id=x' +
      '\x1b]8;;\x1b\\';
    expect(isAuthFlowUrlLine(osc8)).toBe(true);
  });

  it('does not treat explanatory log lines as URL-only lines', () => {
    expect(isAuthFlowUrlLine('Open this URL in your browser to sign in:')).toBe(false);
    expect(isAuthFlowUrlLine('Listening on http://localhost:1455/auth/callback')).toBe(false);
  });

  it('keeps the newest authorize URL available after later status lines arrive', () => {
    const url = 'https://auth.openai.com/oauth/authorize?response_type=code&state=newest';
    expect(
      latestAuthFlowUrl([
        'https://auth.openai.com/oauth/authorize?state=older',
        'A browser window should open. Waiting for you to finish signing in...',
        url,
        '(Listening on http://localhost:1455/auth/callback — press Ctrl+C to cancel.)',
      ]),
    ).toBe(url);
  });

  it('keeps a long clickable login URL visible in a short, narrow terminal', {
    timeout: 5_000,
  }, async () => {
    const url =
      'https://auth.openai.com/oauth/authorize?response_type=code&client_id=app&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&scope=openid&state=long-state';
    const view = renderRealTty(
      React.createElement(AuthPanel, {
        panel: panel({
          view: 'flow',
          flowTitle: 'Sign in with ChatGPT',
          busy: true,
          log: [
            'Uses your ChatGPT Plus/Pro/Team subscription (not an API key).',
            'Using a subscription outside the official Codex client may violate OpenAI Terms.',
            'Open this URL in your browser to sign in:',
            `\x1b]8;;${url}\x1b\\${url}\x1b]8;;\x1b\\`,
            'A browser window should open. Waiting for you to finish signing in...',
            '(Listening on http://localhost:1455/auth/callback — press Ctrl+C to cancel.)',
          ],
        }),
      }),
      { columns: 42, rows: 10 },
    );

    await settle();
    const frame = view.lastFrame();
    const rawFrame = view.stdout.frames.at(-1) ?? '';
    expect(frame).toContain('Open: https://auth.openai.com/');
    expect(rawFrame).toContain(`\x1b]8;;${url}\x1b\\`);
    expect(view.lines().length).toBeLessThanOrEqual(10);
    view.unmount();
  });
});
