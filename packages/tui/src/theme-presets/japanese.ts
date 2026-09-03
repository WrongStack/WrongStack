import type { Theme } from '../theme-types.js';
import { baseTheme } from './base.js';

/** 1 palette: kanagawa. */
export const japanesePresets = {
  kanagawa: Object.freeze({
    ...baseTheme,
    textPrimary: '#dcd7ba',
    textSecondary: '#b8b4a0',
    textMuted: '#8f98a8',
    brandPrimary: '#dca561',
    brandAccent: '#957fb8',
    surface: '#16161d',
    surfaceRaised: '#1f1f28',
    accent: '#7fb4ca',
    user: '#e98a57',
    assistant: '#7fb4ca',
    tool: '#658594',
    success: '#98bb6e',
    warn: '#dca561',
    error: '#c34043',
    borderDefault: '#54546d',
    borderSubtle: '#404058',
    borderActive: '#d27e99',
    brand: '#957fb8',
    diffAddBg: '#1f2d1f',
    diffDelBg: '#321e22',
    monitor: { fleet: '#7fb4ca', agents: '#957fb8', worktree: '#98bb6e', phase: '#7fb4ca' },
  }),
} satisfies Record<string, Theme>;
