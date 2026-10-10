import { type Theme, theme } from '../theme.js';

/**
 * Shared provider-family → Ink color mapping for the TUI model picker,
 * auth panel, and statusline. All values are hex strings compatible with
 * Ink's `<Text color="...">` prop.
 *
 * Palette is aligned with Catppuccin Mocha pastels from animation-style.tsx
 * so the whole TUI feels cohesive.
 */

/** Return a hex color for a known provider family, or a neutral fallback. */
export function colorForFamily(family: string | undefined): string {
  return FAMILY_COLORS[family?.toLowerCase() ?? ''] ?? '#89dceb';
}

/** Return a dimmer variant (used for unselected / secondary text). */
export function dimColorForFamily(family: string | undefined): string {
  return DIMMED_FAMILY_COLORS[family?.toLowerCase() ?? ''] ?? '#585b70';
}

const FAMILY_COLORS: Record<string, string> = {
  anthropic: '#f38ba8',
  'anthropic-oauth': '#f38ba8',
  'anthropic-claude': '#f38ba8',
  openai: '#a6e3a1',
  'openai-codex': '#a6e3a1',
  'openai-compatible': '#94e2d5',
  google: '#89b4fa',
  gemini: '#89b4fa',
  'google-gemini': '#89b4fa',
  'github-copilot': '#cba6f7',
  copilot: '#cba6f7',
  local: '#f9e2af',
  ollama: '#fab387',
  vllm: '#fab387',
  lmstudio: '#f9e2af',
  omniroute: '#eba0ac',
  mistral: '#b4befe',
  groq: '#89dceb',
  together: '#89dceb',
  fireworks: '#89dceb',
  perplexity: '#89dceb',
  deepseek: '#f5c2e7',
};

const DIMMED_FAMILY_COLORS: Record<string, string> = {
  anthropic: '#6c3f4a',
  'anthropic-oauth': '#6c3f4a',
  openai: '#3d5c3d',
  'openai-codex': '#3d5c3d',
  'openai-compatible': '#3a524e',
  google: '#3a4570',
  gemini: '#3a4570',
  'github-copilot': '#4a3f5c',
  copilot: '#4a3f5c',
  local: '#5c5430',
  ollama: '#5c4730',
  vllm: '#5c4730',
  mistral: '#3e3f5c',
  deepseek: '#5c3f50',
};

/** Map a provider or OAuth kind to a badge-like color label. */
export function badgeForKind(
  kind: 'oauth' | 'api_key' | 'session_token' | undefined,
): { label: string; color: string } | undefined {
  switch (kind) {
    case 'oauth':
      return { label: 'oauth', color: '#cba6f7' };
    case 'session_token':
      return { label: 'session', color: '#89dceb' };
    default:
      return undefined;
  }
}

/** Brand colors for known OAuth strategies; unknown plugin strategies use the fallback. */
export const OAUTH_KIND_COLORS: Record<string, string> = {
  chatgpt: '#a6e3a1',
  claude: '#f38ba8',
  copilot: '#cba6f7',
};

/** Semantic UI colors used across auth / model panels. */
function themeColors<K extends string>(tokens: Record<K, keyof Theme>): Record<K, string> {
  return Object.defineProperties(
    {} as Record<K, string>,
    Object.fromEntries(
      Object.entries(tokens).map(([key, token]) => [
        key,
        { enumerable: true, get: () => theme[token as keyof Theme] },
      ]),
    ),
  );
}

export const UI_COLORS = Object.assign(
  themeColors({
    focused: 'accent',
    active: 'success',
    inactive: 'textMuted',
    warning: 'warn',
    error: 'error',
    hint: 'warn',
    border: 'borderActive',
    title: 'brandPrimary',
    selectedModel: 'accent',
  }),
  {
    dimmed: undefined as string | undefined, // Ink dimColor prop
  },
);
