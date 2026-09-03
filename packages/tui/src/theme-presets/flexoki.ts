import type { Theme } from '../theme-types.js';
import { baseTheme } from './base.js';

/** 1 palette: flexoki-dark. */
export const flexokiPresets = {
  'flexoki-dark': Object.freeze({
    ...baseTheme,
    textPrimary: '#cecdc3',
    textSecondary: '#b7b5ac',
    textMuted: '#66645e',
    brandPrimary: '#da702c',
    brandAccent: '#ce5d97',
    surface: '#100f0f',
    surfaceRaised: '#1c1b1a',
    accent: '#4385be',
    user: '#d0a215',
    assistant: '#24837b',
    tool: '#4385be',
    success: '#879a39',
    warn: '#da702c',
    error: '#d14d41',
    borderDefault: '#343331',
    borderSubtle: '#32312f',
    borderActive: '#da702c',
    brand: '#ce5d97',
    diffAddBg: '#192b1a',
    diffDelBg: '#321919',
    monitor: { fleet: '#4385be', agents: '#ce5d97', worktree: '#879a39', phase: '#24837b' },
  }),
} satisfies Record<string, Theme>;
