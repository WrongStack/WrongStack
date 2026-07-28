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

/** Colors for the three OAuth kinds shown in the auth panel. */
export const OAUTH_KIND_COLORS: Record<string, string> = {
  chatgpt: '#a6e3a1',
  claude: '#f38ba8',
  copilot: '#cba6f7',
};

/** Semantic UI colors used across auth / model panels. */
export const UI_COLORS = {
  focused: '#89b4fa',
  active: '#a6e3a1',
  inactive: '#585b70',
  warning: '#f9e2af',
  error: '#f38ba8',
  hint: '#f9e2af',
  border: '#89b4fa',
  title: '#89b4fa',
  selectedModel: '#89b4fa',
  dimmed: undefined as string | undefined, // Ink dimColor prop
} as const;

/**
 * Statusline item category colors — imported by status-bar.tsx and
 * statusline-picker.tsx so chips are distinguishable at a glance.
 *
 * Keys match `StatuslineItem` union member names.
 */
export const STATUSLINE_ITEM_COLORS: Record<string, string> = {
  // Agent/providers
  model: '#a6e3a1',
  state: '#89dceb',
  mode: '#89b4fa',
  autonomy: '#cba6f7',
  auto_proceed: '#cba6f7',
  eternal_stage: '#cba6f7',
  goal: '#f9e2af',

  // Tokens & cost
  tokens: '#f9e2af',
  token_saving: '#f9e2af',
  cost: '#fab387',
  cache: '#94e2d5',
  context: '#f5c2e7',

  // Queue / fleet
  queue: '#89dceb',
  fleet: '#89b4fa',
  fleet_agents: '#89b4fa',

  // Work
  todos: '#a6e3a1',
  plan: '#a6e3a1',
  tasks: '#a6e3a1',

  // Git / version / info
  version: '#585b70',
  git: '#585b70',
  working_dir: '#585b70',
  project: '#585b70',
  elapsed: '#585b70',
  sessions: '#585b70',
  tools: '#585b70',

  // Dynamic chips
  brain: '#cba6f7',
  mailbox: '#89b4fa',
  enhance: '#a6e3a1',
  debug_stream: '#f38ba8',
  hint: '#f9e2af',
  index: '#94e2d5',
  breaker: '#f38ba8',
  next_steps: '#89dceb',
};
