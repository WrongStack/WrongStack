import type { ThemePresetId } from '@wrongstack/contracts/types';

export type SyntaxRole =
  | 'keyword'
  | 'string'
  | 'comment'
  | 'commentOnWash'
  | 'number'
  | 'literal'
  | 'property'
  | 'variable'
  | 'command'
  | 'flag'
  | 'decorator'
  | 'diffAdd'
  | 'diffDel'
  | 'diffMeta';

export type SyntaxPalette = Record<SyntaxRole, string>;

export type ThemeName = ThemePresetId;

export interface ThemePickerOption {
  id: ThemeName;
  name: string;
  description: string;
  /**
   * Palette family (Catppuccin, Tokyo Night, Gruvbox, …) used to group
   * related rows in the picker. Sourced from `THEME_PRESET_META` in
   * `@wrongstack/core/types`, the same table the CLI reads.
   */
  family: string;
}

export interface Theme {
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  brandPrimary: string;
  brandAccent: string;
  surface: string;
  surfaceRaised: string;
  accent: string;
  user: string;
  assistant: string;
  tool: string;
  success: string;
  warn: string;
  error: string;
  dim: true | string;
  supportsBackground: boolean;
  borderDefault: string;
  borderSubtle: string;
  borderActive: string;
  brand: string;
  monitor: {
    fleet: string;
    agents: string;
    worktree: string;
    phase: string;
  };
  diffAddBg: string;
  diffDelBg: string;
  syntax?: Partial<SyntaxPalette> | undefined;
}

export type ThemeListener = (name: ThemeName) => void;
