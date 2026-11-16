import { defineConfig } from 'vitest/config';
import base from './vitest.config.js';

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['tests/browser-terminal.browser.tsx', 'tests/browser-pty.browser.ts'],
    env: { WRONGSTACK_TUI_ICON_STYLE: 'browser', WRONGSTACK_TUI_TERMINAL: 'browser' },
    maxWorkers: 1,
  },
});
