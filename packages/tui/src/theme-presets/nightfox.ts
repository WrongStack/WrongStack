import type { Theme } from '../theme-types.js';
import { baseTheme } from './base.js';

/** 1 palette: nightfox. */
export const nightfoxPresets = {
  nightfox: Object.freeze({
    ...baseTheme,
    textPrimary: '#cdcecf',
    textSecondary: '#aeafb0',
    textMuted: '#71839b',
    brandPrimary: '#f4a261',
    brandAccent: '#9d79d6',
    surface: '#192330',
    surfaceRaised: '#212e3f',
    accent: '#719cd6',
    user: '#dbc074',
    assistant: '#63cdcf',
    tool: '#719cd6',
    success: '#81b29a',
    warn: '#dbc074',
    error: '#c94f6d',
    borderDefault: '#39506d',
    borderSubtle: '#314963',
    borderActive: '#719cd6',
    brand: '#9d79d6',
    diffAddBg: '#1d3025',
    diffDelBg: '#33202a',
    monitor: { fleet: '#719cd6', agents: '#9d79d6', worktree: '#81b29a', phase: '#63cdcf' },
  }),
} satisfies Record<string, Theme>;
