import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { Banner } from '../src/components/history/banner.js';
import type { AutonomyAgentStatus } from '../src/components/history/types.js';

describe('<Banner /> — additional coverage', () => {
  it('renders with keyTail, sessionId, profile, and family', () => {
    const { lastFrame, unmount } = render(
      React.createElement(Banner, {
        termWidth: 80,
        entry: {
          id: 0,
          kind: 'banner',
          version: '1.0.0',
          provider: 'openai',
          model: 'gpt-4',
          cwd: '/home/user/project',
          family: 'gpt-4-family',
          keyTail: 'XYZ99',
          sessionId: 'sess_abc123',
          profile: 'my-ai-profile',
        } as const,
      }),
    );
    const frame = lastFrame() ?? '';
    unmount();
    expect(frame).toContain('gpt-4-family');
    expect(frame).toContain('•••• XYZ99');
    expect(frame).toContain('sess_abc123');
    expect(frame).toContain('my-ai-profile');
    expect(frame).toContain('gpt-4');
  });

  it('renders compact layout when panelWidth < FULL_LAYOUT_MIN_WIDTH', () => {
    const { lastFrame, unmount } = render(
      React.createElement(Banner, {
        termWidth: 44,
        entry: {
          id: 0,
          kind: 'banner',
          version: '0.1.0',
          provider: 'test',
          model: 'test-model',
          cwd: '/tmp',
        } as const,
      }),
    );
    const frame = lastFrame() ?? '';
    unmount();
    // compact shows gradient "WrongStack" text
    expect(frame).toContain('WrongStack');
    // compact hides pixel wordmark
    expect(frame).not.toContain('WRONGSTACK');
  });

  it('renders autonomy agents section when agents are present', () => {
    const agents: AutonomyAgentStatus[] = [
      { name: 'Brain', online: true, detail: 'agentic' },
      { name: 'Memory', online: false },
      { name: 'Kanban', online: true, detail: 'tracking' },
    ];
    const { lastFrame, unmount } = render(
      React.createElement(Banner, {
        termWidth: 80,
        entry: {
          id: 0,
          kind: 'banner',
          version: '2.0.0',
          provider: 'anthropic',
          model: 'claude',
          cwd: '/workspace',
          autonomyAgents: agents,
        } as const,
      }),
    );
    const frame = lastFrame() ?? '';
    unmount();
    expect(frame).toContain('Brain');
    expect(frame).toContain('Memory');
    expect(frame).toContain('Kanban');
  });

  it('does not render autonomy agents section when agents array is empty', () => {
    const { lastFrame, unmount } = render(
      React.createElement(Banner, {
        termWidth: 80,
        entry: {
          id: 0,
          kind: 'banner',
          version: '1.0.0',
          provider: 'test',
          model: 'test',
          cwd: '/tmp',
          autonomyAgents: [],
        } as const,
      }),
    );
    const frame = lastFrame() ?? '';
    unmount();
    // The agents section should be absent
    expect(
      frame.split('\n').filter((l) => l.includes('Brain') || l.includes('Shadow')).length,
    ).toBe(0);
  });

  it('omits family keyTail sessionId profile when not provided (full layout)', () => {
    const { lastFrame, unmount } = render(
      React.createElement(Banner, {
        termWidth: 80,
        entry: {
          id: 0,
          kind: 'banner',
          version: '1.0.0',
          provider: 'minimal',
          model: 'provider',
          cwd: '/workspace',
        } as const,
      }),
    );
    const frame = lastFrame() ?? '';
    unmount();
    // Must not contain optional fields that weren't provided
    expect(frame).not.toContain('◈');
  });

  it('renders correctly with termWidth = 0 (edge case)', () => {
    const { lastFrame, unmount } = render(
      React.createElement(Banner, {
        termWidth: 0,
        entry: {
          id: 0,
          kind: 'banner',
          version: '1.0.0',
          provider: 'test',
          model: 'm',
          cwd: '/x',
        } as const,
      }),
    );
    const frame = lastFrame() ?? '';
    unmount();
    // Should still produce at least some output without crashing
    expect(frame).toBeDefined();
    expect(frame.length).toBeGreaterThan(0);
  });

  it('truncates long cwd with shortenPath', () => {
    const longCwd = '/a/very/deep/nested/project/directory/for/testing';
    const { lastFrame, unmount } = render(
      React.createElement(Banner, {
        termWidth: 60,
        entry: {
          id: 0,
          kind: 'banner',
          version: '1.0.0',
          provider: 'p',
          model: 'm',
          cwd: longCwd,
        } as const,
      }),
    );
    const frame = lastFrame() ?? '';
    unmount();
    // The cwd should appear somewhere (truncated)
    expect(frame).toContain('testing');
    // Compact label (6 chars for compact mode) for cwd
    expect(frame).toContain('cwd');
  });

  it('renders the full profile config path when profileConfigPath is provided', () => {
    const { lastFrame, unmount } = render(
      React.createElement(Banner, {
        termWidth: 100,
        entry: {
          id: 0,
          kind: 'banner',
          version: '1.0.0',
          provider: 'openai',
          model: 'gpt-4',
          cwd: '/home/user/project',
          profile: 'default',
          profileConfigPath: '~/.wrongstack/profiles/default/config.json',
        } as const,
      }),
    );
    const frame = lastFrame() ?? '';
    unmount();
    // The full path is rendered (not just the bare "default" name).
    expect(frame).toContain('~/.wrongstack/profiles/default/config.json');
    // The profile label is still present.
    expect(frame).toContain('profile');
  });

  it('falls back to the bare profile name when profileConfigPath is absent', () => {
    const { lastFrame, unmount } = render(
      React.createElement(Banner, {
        termWidth: 80,
        entry: {
          id: 0,
          kind: 'banner',
          version: '1.0.0',
          provider: 'openai',
          model: 'gpt-4',
          cwd: '/home/user/project',
          profile: 'work-profile',
        } as const,
      }),
    );
    const frame = lastFrame() ?? '';
    unmount();
    expect(frame).toContain('work-profile');
    expect(frame).not.toContain('config.json');
  });

  it('omits the profile row entirely when neither field is set', () => {
    const { lastFrame, unmount } = render(
      React.createElement(Banner, {
        termWidth: 80,
        entry: {
          id: 0,
          kind: 'banner',
          version: '1.0.0',
          provider: 'openai',
          model: 'gpt-4',
          cwd: '/home/user/project',
        } as const,
      }),
    );
    const frame = lastFrame() ?? '';
    unmount();
    expect(frame).not.toContain('profile');
  });
});

import { bannerGradientColor } from '../src/components/history/banner.js';

describe('bannerGradientColor', () => {
  it('returns a color string for single-position gradient', () => {
    const color = bannerGradientColor(0, 1);
    expect(color).toBeDefined();
    expect(typeof color).toBe('string');
  });
});
