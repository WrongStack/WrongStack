import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { StatusBar, type StatusBarProps } from '../src/components/status-bar.js';

/**
 * Raw-SGR color pins for the status bar — the only statusline tests that
 * must run outside the default vitest worker.
 *
 * These pins assert the raw `\x1b[38;2;253;159;2m` escape (STACK_ORANGE
 * #FD9F02). Ink → chalk renders `<Text color>` via `chalk.hex()`; chalk's
 * color level is auto-detected from `process.stdout.isTTY`, `COLORTERM`, and
 * `FORCE_COLOR` — in the default vitest worker (non-TTY, no env) it resolves
 * to 0 (disabled) and the brand-orange truecolor is silently stripped before
 * `ink-testing-library` ever sees it. This file therefore runs under the
 * dedicated config `vitest.status-bar-sgr.config.ts`
 * (`pnpm test:status-bar`), which sets `FORCE_COLOR=3` +
 * `COLORTERM=truecolor` at worker start so chalk initializes at level 3.
 * `FORCE_COLOR=1` alone would only force 16-color mode and downsample the
 * orange to a basic ANSI code. Applying these env vars package-wide breaks
 * ~55 unrelated ink tests that depend on the default non-color path.
 *
 * Everything else that used to live in status-bar-overflow.test.ts now runs
 * in the main config (width-controlled via renderRealTty, text-level
 * assertions only).
 */

describe('StatusBar version-chip SGR color pins', () => {
  it('tints the update suffix with STACK_ORANGE truecolor', () => {
    // The update suffix must be tinted with STACK_ORANGE (#FD9F02 = truecolor
    // \x1b[38;2;253;159;2m). Render a raw (non-ANSI-stripped) frame —
    // stripping SGR before matching would silently swallow this assertion.
    // Pinning the escape stops a future refactor from swapping the brand
    // orange for theme.warn (pastel yellow) unnoticed.
    const { lastFrame, unmount } = render(
      React.createElement(StatusBar, {
        model: 'anthropic/claude',
        state: 'idle',
        version: '0.7.0',
        latestVersion: '0.8.1',
        updateAvailable: true,
      } as StatusBarProps),
    );
    const raw = lastFrame() ?? '';
    unmount();
    expect(raw).toMatch(/\x1b\[38;2;253;159;2m.*\(update v0\.8\.1\)/);
  });

  it('renders the update chip monochrome (no orange SGR) in no-color mode', () => {
    // Render a raw (non-ANSI-stripped) frame — stripping SGR before matching
    // would make a negative SGR assertion vacuous (it could never fail).
    // Asserting on the raw frame actually catches a regression where no-color
    // mode still emits orange truecolor.
    const { lastFrame, unmount } = render(
      React.createElement(StatusBar, {
        model: 'anthropic/claude',
        state: 'idle',
        version: '0.7.0',
        latestVersion: '0.8.1',
        updateAvailable: true,
        mode: 'no-color',
      } as StatusBarProps),
    );
    const raw = lastFrame() ?? '';
    unmount();
    expect(raw).toContain('v0.7.0');
    expect(raw).toContain('(update v0.8.1)');
    // The brand-orange truecolor (STACK_ORANGE #FD9F02 = 253;159;2) must not
    // survive in no-color mode. Assert the specific orange SGR rather than
    // "any truecolor": the unrelated `+N dropped` overflow marker emits
    // theme.textMuted truecolor unconditionally (not gated by monochrome), so
    // a blanket `not.toMatch(/\x1b\[38;2;/)` could fail spuriously when line 1
    // overflows — even though the chip is correctly monochrome. (The marker's
    // unconditional color is a separate pre-existing powerline-rail concern,
    // not a version-chip regression.)
    expect(raw).not.toMatch(/\x1b\[38;2;253;159;2m/);
  });
});
