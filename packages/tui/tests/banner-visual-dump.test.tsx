// TEMPORARY — visual verification of ProfileRow. Deleted after use.
import { render } from 'ink-testing-library';
import React from 'react';
import { describe, it } from 'vitest';
import { Banner } from '../src/components/history/banner.js';

// Force chalk to emit ANSI color codes even in the test runner's non-TTY env.
process.env.FORCE_COLOR = '1';

// STACK_ORANGE = #FD9F02 → ANSI 24-bit: ESC[38;2;253;159;2m
const ORANGE_ANSI = '\x1b[38;2;253;159;2m';
const MUTED_ANSI = '\x1b[38;2;182;178;168m'; // #B6B2A8

describe('VISUAL DUMP', () => {
  it('renders profileConfigPath with color codes visible', () => {
    const cases = [
      {
        label: 'CASE 1: profileConfigPath present',
        termWidth: 100,
        entry: {
          id: 0,
          kind: 'banner' as const,
          version: '0.285.0',
          provider: 'deepseek',
          model: 'deepseek-v4-flash',
          cwd: '/home/user/myproject',
          profile: 'default',
          profileConfigPath: '~/.wrongstack/profiles/default/config.json',
        },
      },
      {
        label: 'CASE 2: custom profile name',
        termWidth: 100,
        entry: {
          id: 0,
          kind: 'banner' as const,
          version: '0.285.0',
          provider: 'anthropic',
          model: 'claude-sonnet-4',
          cwd: '/home/user/work',
          profile: 'work-claude',
          profileConfigPath: '~/.wrongstack/profiles/work-claude/config.json',
        },
      },
      {
        label: 'CASE 3: bare profile only (fallback)',
        termWidth: 80,
        entry: {
          id: 0,
          kind: 'banner' as const,
          version: '0.285.0',
          provider: 'openai',
          model: 'gpt-4o',
          cwd: '/home/user/project',
          profile: 'my-profile',
        },
      },
      {
        label: 'CASE 4: narrow terminal (truncation)',
        termWidth: 60,
        entry: {
          id: 0,
          kind: 'banner' as const,
          version: '0.285.0',
          provider: 'anthropic',
          model: 'claude-sonnet-4',
          cwd: '/home/user/deep/nested/project',
          profile: 'default',
          profileConfigPath: '~/.wrongstack/profiles/default/config.json',
        },
      },
    ];

    for (const c of cases) {
      const { lastFrame, unmount } = render(
        React.createElement(Banner, { termWidth: c.termWidth, entry: c.entry as never }),
      );
      const raw = lastFrame() ?? '';
      unmount();
      const stripped = raw.replace(/\x1b\[[0-9;]*m/g, '');

      console.log(`\n${'═'.repeat(72)}`);
      console.log(`  ${c.label} (termWidth=${c.termWidth})`);
      console.log(`${'═'.repeat(72)}`);
      console.log('--- ANSI-visible (ESC shown as ⟦) ---');
      console.log(raw.replace(/\x1b/g, '⟦'));
      console.log('--- PLAIN TEXT ---');
      console.log(stripped);
    }

    // ── Direct color-code verification ──────────────────────────────────
    // ink-testing-library strips color in its write stream, so verify the
    // ProfileRow JSX structure produces the correct ANSI sequences by
    // checking the raw frame for the exact escape codes.

    // Re-render Case 1 to inspect its raw bytes.
    const { lastFrame: lf1 } = render(
      React.createElement(Banner, {
        termWidth: 100,
        entry: {
          id: 0,
          kind: 'banner' as const,
          version: '0.285.0',
          provider: 'deepseek',
          model: 'deepseek-v4-flash',
          cwd: '/home/user/myproject',
          profile: 'default',
          profileConfigPath: '~/.wrongstack/profiles/default/config.json',
        } as never,
      }),
    );
    const raw1 = lf1() ?? '';

    console.log('\n━━━ COLOR CODE CHECK ━━━');
    console.log(
      `ORANGE_ANSI (${ORANGE_ANSI.replace(/\x1b/g, '⟦')}) present: ${raw1.includes(ORANGE_ANSI)}`,
    );
    console.log(
      `MUTED_ANSI  (${MUTED_ANSI.replace(/\x1b/g, '⟦')}) present: ${raw1.includes(MUTED_ANSI)}`,
    );
    console.log(
      `Profile row segment "default" preceded by orange bold: ${raw1.includes(`${ORANGE_ANSI}\x1b[1mdefault`)}`,
    );

    // Find the profile row in raw output and show its escape-sequence breakdown.
    const profileLineIdx = raw1.indexOf('profile');
    if (profileLineIdx >= 0) {
      // Extract a window around the profile value, showing escape codes
      const start = raw1.lastIndexOf('\n', profileLineIdx) + 1;
      const end = raw1.indexOf('\n', profileLineIdx);
      const profileRow = raw1.slice(start, end).replace(/\x1b\[/g, '⟦');
      console.log(`\nProfile row raw (first 200 chars):\n  ${profileRow.slice(0, 200)}`);
    }
  });
});
