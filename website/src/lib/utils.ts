import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { pluginCatalog } from '@/data/runtime-catalog';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/* =========================================================================
   Site data — every value is sourced from the WrongStack codebase
   (README.md / AGENTS.md / package manifests). No invented numbers.
   The skills catalog and the changelog live in src/data/ and are
   re-exported below so the @/lib/utils public surface stays stable.
   ========================================================================= */

export const META = {
  version: '1.0.37',
  repo: 'https://github.com/WrongStack/WrongStack',
  license: 'MIT',
  domain: 'wrongstack.com',
} as const;

export type { ChangelogEntry } from '@/data/changelog';
export { changelog } from '@/data/changelog';
export { SKILL_COUNT, skills } from '@/data/skills';

/** The built-in tools from packages/tools/src/builtin.ts, grouped. */
export const toolGroups = [
  {
    label: 'Browser & E2E',
    tools: [
      'browser_open',
      'browser_status',
      'browser_list',
      'browser_navigate',
      'browser_snapshot',
      'browser_screenshot',
      'browser_click',
      'browser_type',
      'browser_select',
      'browser_press',
      'browser_hover',
      'browser_drag',
      'browser_wait',
      'browser_evaluate',
      'browser_upload',
      'browser_close',
      'e2e_plan',
    ],
  },
  {
    label: 'Files & search',
    tools: ['read', 'write', 'edit', 'replace', 'glob', 'grep', 'patch', 'diff', 'tree', 'json'],
  },
  {
    label: 'Shell, Git & web',
    tools: ['bash', 'exec', 'pwsh', 'git', 'fetch', 'read_url_content', 'search'],
  },
  {
    label: 'Work & state',
    tools: ['todo', 'plan', 'kanban', 'task', 'clarify'],
  },
  {
    label: 'Quality & language',
    tools: [
      'lint',
      'format',
      'typecheck',
      'test',
      'codebase-targeted-test',
      'security-ast-scan',
      'language_info',
      'language',
      'language_package',
    ],
  },
  { label: 'Dependencies', tools: ['install', 'audit', 'outdated', 'logs'] },
  { label: 'Generation', tools: ['design'] },
  {
    label: 'Discovery & index',
    tools: [
      'tool_search',
      'tool_use',
      'codebase-index',
      'codebase-search',
      'codebase-skeleton',
      'codebase-read-symbol',
      'codebase-repo-map',
      'codebase-ast-replace',
      'codebase-invariant-check',
      'codebase-impact-analysis',
      'codebase-incoming-calls',
      'codebase-outgoing-calls',
      'codebase-stats',
      'dead-code-scan',
    ],
  },
] as const;

/** Provider wire families — from models.dev, no hardcoded models or pricing. */
export const providerFamilies = [
  {
    id: 'anthropic',
    transport: 'Native Claude API + SSE',
    examples: ['Anthropic', 'MiniMax', 'Kimi', 'Vertex (Anthropic)'],
  },
  {
    id: 'openai',
    transport: 'OpenAI Chat Completions + SSE',
    examples: ['OpenAI', 'Perplexity', 'Vivgrid'],
  },
  {
    id: 'openai-compatible',
    transport: 'OpenAI-spec endpoints + SSE',
    examples: [
      'Mistral',
      'Groq',
      'DeepSeek',
      'OpenRouter',
      'Together',
      'xAI',
      'Cerebras',
      'Ollama',
      'Fireworks',
      'Moonshot',
      'GLM',
      'Alibaba',
    ],
  },
  {
    id: 'google',
    transport: 'Gemini streamGenerateContent (SSE)',
    examples: ['Google AI Studio'],
  },
] as const;

/** Derived count — always matches the actual array length, never hardcode. */

/** Visible slash commands from the CLI, TUI, plug-lsp, and core first-party plugins. */
export const slashCommands = [
  '/acp',
  '/agents',
  '/audit',
  '/auth',
  '/autonomy',
  '/btw',
  '/chimera',
  '/clear',
  '/codebase-reindex',
  '/collab',
  '/commit',
  '/compact',
  '/context',
  '/coordinator',
  '/dev',
  '/diag',
  '/delegate',
  '/director',
  '/desktop',
  '/design',
  '/doctor',
  '/enhance',
  '/effort',
  '/ensemble',
  '/exit',
  '/f',
  '/fallback',
  '/fix',
  '/fleet',
  '/gitcheck',
  '/goal',
  '/goals',
  '/health',
  '/help',
  '/hq',
  '/init',
  '/interrupt',
  '/kanban',
  '/lsp',
  '/mailbox',
  '/mailbox-demo',
  '/mailbox-serve',
  '/mcp',
  '/memory',
  '/metrics',
  '/mode',
  '/model',
  '/modelcaps',
  '/models',
  '/mouse',
  '/next',
  '/nextsteps',
  '/plan',
  '/permissions',
  '/plugin',
  '/prompt',
  '/prompt-gen',
  '/prompts',
  '/project',
  '/prune',
  '/push',
  '/queue',
  '/review',
  '/save',
  '/sdd',
  '/security',
  '/setmodel',
  '/settings',
  '/sessions',
  '/shadow',
  '/skill',
  '/skill-gen',
  '/skill-import',
  '/skill-install',
  '/skill-search',
  '/skill-uninstall',
  '/skill-update',
  '/spawn',
  '/solo',
  '/stats',
  '/statusline',
  '/steer',
  '/suggest',
  '/supervisor',
  '/sync',
  '/tasks',
  '/techstack',
  '/telegram-settings',
  '/telegram-setup',
  '/tool',
  '/todos',
  '/tools',
  '/webui',
  '/working_dir',
  '/worktree',
  '/yolo',
] as const;

/** Published workspace inventory: 34 packages and 2 apps. */
export const packages = [
  'wrongstack',
  '@wrongstack/core',
  '@wrongstack/cli',
  '@wrongstack/providers',
  '@wrongstack/plugin-sdk',
  '@wrongstack/primitives',
  '@wrongstack/tools',
  '@wrongstack/mcp',
  '@wrongstack/plug-lsp',
  '@wrongstack/runtime',
  '@wrongstack/kanban',
  '@wrongstack/kanban-mcp',
  '@wrongstack/mailbox-mcp',
  '@wrongstack/codebase-index-mcp',
  '@wrongstack/sdd',
  '@wrongstack/security-scanner',
  '@wrongstack/sage',
  '@wrongstack/sage-mcp',
  '@wrongstack/persistence',
  '@wrongstack/governance',
  '@wrongstack/requirement-intake',
  '@wrongstack/requirement-intake-mcp',
  '@wrongstack/simpleui',
  '@wrongstack/techstack',
  '@wrongstack/tui',
  '@wrongstack/webui',
  '@wrongstack/webui-protocol',
  '@wrongstack/webui-server',
  '@wrongstack/webui-hq',
  '@wrongstack/telegram',
  '@wrongstack/vector-memory',
  '@wrongstack/plugins',
  '@wrongstack/bench',
  '@wrongstack/acp',
  '@wrongstack/wrongtrace',
  '@wrongstack/desktop',
] as const;

/** Managed first-party plugin catalog, shared with the dedicated plugin page. */
export const plugins = pluginCatalog.map(({ name, summary }) => ({ name, note: summary }));
