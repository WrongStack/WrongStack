import type { Theme } from '../theme-types.js';
import { detectSupportsBackground, pastel } from '../theme-utils.js';

export const baseTheme: Theme = {
  textPrimary: pastel.white,
  textSecondary: '#bac2de',
  textMuted: '#6c7086',
  brandPrimary: pastel.peach,
  brandAccent: pastel.pink,
  surface: '#181825',
  surfaceRaised: '#1e1e2e',
  accent: pastel.cyan,
  user: pastel.yellow,
  assistant: pastel.cyan,
  tool: pastel.cyan,
  success: pastel.green,
  warn: pastel.yellow,
  error: pastel.red,
  dim: true,
  borderDefault: pastel.blackBright,
  borderSubtle: pastel.surface0,
  borderActive: pastel.yellow,
  brand: pastel.magenta,
  monitor: {
    fleet: pastel.cyan,
    agents: pastel.magenta,
    worktree: pastel.green,
    phase: pastel.cyan,
  },
  diffAddBg: '#1e3b2a',
  diffDelBg: '#3b1f26',
  supportsBackground: detectSupportsBackground(),
};
