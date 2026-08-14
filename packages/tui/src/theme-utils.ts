import type { SyntaxPalette, SyntaxRole, Theme } from './theme-types.js';

export const pastel = Object.freeze({
  black: '#11111b',
  red: '#f38ba8',
  green: '#a6e3a1',
  yellow: '#f9e2af',
  blue: '#89b4fa',
  magenta: '#cba6f7',
  cyan: '#94e2d5',
  white: '#cdd6f4',
  gray: '#7f849c',
  grey: '#7f849c',
  grayBright: '#a6adc8',
  greyBright: '#a6adc8',
  blackBright: '#585b70',
  redBright: '#eba0ac',
  greenBright: '#b8e8b0',
  yellowBright: '#f5e6b8',
  blueBright: '#89dceb',
  magentaBright: '#b4befe',
  cyanBright: '#99e6da',
  whiteBright: '#ffffff',
  peach: '#fab387',
  pink: '#f5c2e7',
  surface0: '#313244',
  surface1: '#45475a',
  subtext0: '#a6adc8',
  flamingo: '#f2cdcd',
} as const);

export const catppuccin = pastel;

export const SYNTAX_TOKEN: Readonly<Record<SyntaxRole, keyof Theme>> = Object.freeze({
  keyword: 'brand',
  string: 'success',
  comment: 'textMuted',
  commentOnWash: 'textSecondary',
  number: 'warn',
  literal: 'warn',
  property: 'accent',
  variable: 'accent',
  command: 'accent',
  flag: 'warn',
  decorator: 'brand',
  diffAdd: 'success',
  diffDel: 'error',
  diffMeta: 'accent',
});

const SYNTAX_PREFIX = 'syntax.';

const ANSI_TOKEN: Readonly<Record<string, keyof Theme>> = Object.freeze({
  cyan: 'accent',
  yellow: 'warn',
  green: 'success',
  red: 'error',
  magenta: 'brand',
  white: 'textPrimary',
});

export function resolveSyntaxColor(role: SyntaxRole, palette: Theme): string {
  return palette.syntax?.[role] ?? (palette[SYNTAX_TOKEN[role]] as string);
}

export function resolveSyntaxPalette(palette: Theme): SyntaxPalette {
  const out = {} as SyntaxPalette;
  for (const role of Object.keys(SYNTAX_TOKEN) as SyntaxRole[]) {
    out[role] = resolveSyntaxColor(role, palette);
  }
  return out;
}

export function softColorWithTheme(color: string | undefined, currentTheme: Theme): string | undefined {
  if (!color) return color;
  if (color.startsWith(SYNTAX_PREFIX)) {
    const role = color.slice(SYNTAX_PREFIX.length) as SyntaxRole;
    return role in SYNTAX_TOKEN ? resolveSyntaxColor(role, currentTheme) : color;
  }
  const token = ANSI_TOKEN[color];
  if (token !== undefined) {
    const resolved = currentTheme[token];
    if (typeof resolved === 'string') return resolved;
  }
  return (pastel as Record<string, string>)[color] ?? color;
}

export function detectSupportsBackground(
  env: NodeJS.ProcessEnv = process.env,
  isTTY: boolean = process.stdout.isTTY ?? false,
): boolean {
  if (!isTTY) return false;
  if (typeof env.NO_COLOR === 'string' && env.NO_COLOR !== '') return false;
  const colorterm = env.COLORTERM ?? '';
  if (/^(truecolor|24bit)$/i.test(colorterm)) return true;
  const term = env.TERM ?? '';
  if (/truecolor|24bit/i.test(term)) return true;
  if (/256(color)?/i.test(term)) return true;
  if (colorterm !== '' && colorterm !== 'false') return true;
  return true;
}
