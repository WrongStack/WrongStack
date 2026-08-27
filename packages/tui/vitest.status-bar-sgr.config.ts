import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Dedicated vitest config for `tests/status-bar-sgr.test.ts` — the raw-SGR
 * color pins of the statusline suite.
 *
 * Those tests assert the raw `\x1b[38;2;253;159;2m` escape (STACK_ORANGE
 * #FD9F02). Ink → chalk renders `<Text color>` via `chalk.hex()`; chalk's
 * color level is auto-detected from `process.stdout.isTTY`, `COLORTERM`, and
 * `FORCE_COLOR` — in vitest's non-TTY worker it resolves to 0 (disabled) and
 * the brand-orange truecolor is silently stripped before `ink-testing-library`
 * ever sees it. `FORCE_COLOR=1` alone only forces level 1 (16-color), which
 * downsamples `#FD9F02` to a basic ANSI code rather than the expected
 * truecolor.
 *
 * `FORCE_COLOR=3` + `COLORTERM=truecolor` force chalk to its truecolor level
 * (24-bit) so `chalk.hex('#FD9F02')` emits exactly the escape the assertions
 * pin. These are set at worker start so chalk's auto-detection picks them up
 * at initialization.
 *
 * Scoped to this test file only — applying these env vars package-wide breaks
 * ~55 unrelated ink tests that depend on the default non-color path. The
 * no-color case in the same test file passes its own `mode: 'no-color'` prop,
 * which the component honors regardless of the env vars.
 *
 * (Renamed 2026-08-27 from vitest.status-bar-overflow.config.ts when the
 * overflow tests were rewritten onto renderRealTty and re-included in the
 * main config — only the SGR pins still need this isolation.)
 */
export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    // Override the base exclude — the dedicated config IS where this file
    // must run; the base exclude exists to keep `pnpm test` / root CI from
    // running it without the FORCE_COLOR/COLORTERM env below.
    include: ['tests/status-bar-sgr.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    env: {
      FORCE_COLOR: '3',
      COLORTERM: 'truecolor',
    },
  },
});
