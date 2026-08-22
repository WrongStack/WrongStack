import type { MCPServerConfig } from './contracts.js';

export interface OfficialServer {
  name: string;
  description: string;
  transport: string;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  allowedTools?: string[];
  requiresEnvVars?: string[];
  badge?: string;
}

/**
 * Curated list of official/recommended MCP servers available to WrongStack users.
 * Displayed in the "Recommended" tab of the MCP Settings section.
 *
 * Each entry includes everything needed to add the server — the user can
 * click "Add" and the config is pre-filled. Servers marked `enabled: false`
 * are off by default; the user explicitly enables them.
 *
 * Env var requirements are listed in `requiresEnvVars` for display purposes;
 * the actual credential handling is server-side.
 */
export const OFFICIAL_SERVERS: OfficialServer[] = [
  {
    name: 'filesystem',
    description: 'Read, write, and navigate the local filesystem. Good for exploring projects.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
  },
  {
    name: 'github',
    description: 'GitHub API — issues, PRs, repos, search, and file operations.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    requiresEnvVars: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
    badge: 'Popular',
  },
  {
    name: 'context7',
    description: 'Codebase-aware documentation and Q&A grounded in your actual library versions.',
    transport: 'streamable-http',
    url: 'https://mcp.context7.com/mcp',
    badge: 'New',
  },
  {
    name: 'brave-search',
    description: 'Web search via Brave Browser. Free tier: 2,000 queries/month.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-brave-search'],
    requiresEnvVars: ['BRAVE_SEARCH_API_KEY'],
  },
  {
    name: 'google-maps',
    description: 'Directions, geocoding, places, and distance matrix via Google Maps.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-google-maps'],
    requiresEnvVars: ['GOOGLE_MAPS_API_KEY'],
  },
  {
    name: 'aws',
    description: 'AWS — EC2, S3, Lambda, IAM, CloudFormation, and cost management.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-aws'],
    requiresEnvVars: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'],
  },
  {
    name: 'slack',
    description: 'Slack — messaging, channels, and search.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-slack'],
    requiresEnvVars: ['SLACK_BOT_TOKEN'],
  },
  {
    name: 'everart',
    description: 'AI image generation via multiple providers.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-everart'],
    requiresEnvVars: ['EVERART_API_KEY'],
  },
  {
    name: 'sentinel',
    description: 'Security vulnerability scanning via Sentinel.',
    transport: 'streamable-http',
    url: 'https://mcp.sentinel.ai',
    badge: 'Security',
  },
  {
    name: 'playwright',
    description:
      'Browser automation — navigate, click, type, screenshot, evaluate JS (headless Chromium).',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-playwright'],
    badge: 'Browser',
  },
  {
    name: 'zai-vision',
    description: 'Image analysis, screenshot understanding, and diagram interpretation.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@z_ai/mcp-server@latest'],
    env: { Z_AI_MODE: 'ZAI' },
    requiresEnvVars: ['Z_AI_API_KEY'],
    allowedTools: [
      'image_analysis',
      'extract_text_from_screenshot',
      'diagnose_error_screenshot',
      'understand_technical_diagram',
      'analyze_data_visualization',
      'ui_diff_check',
    ],
    badge: 'Vision',
  },
  {
    name: 'minimax-vision',
    description: 'MiniMax image understanding via understand_image (read-only, safe for auto-run).',
    transport: 'stdio',
    command: 'uvx',
    args: ['minimax-coding-plan-mcp', '-y'],
    env: {
      MINIMAX_MCP_BASE_PATH: './.wrongstack/minimax-output',
      MINIMAX_API_HOST: 'https://api.minimax.io',
      MINIMAX_API_RESOURCE_MODE: 'url',
    },
    requiresEnvVars: ['MINIMAX_API_KEY'],
    allowedTools: ['understand_image'],
    badge: 'Vision',
  },
  {
    name: 'block',
    description: 'Postgres database access via SQL (Block MCP server).',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-block'],
    requiresEnvVars: ['DATABASE_URL'],
  },
];

/**
 * Convert an OfficialServer entry into an MCPServerConfig (omits display-only fields).
 */
export function toServerConfig(server: OfficialServer, enabled = false): MCPServerConfig {
  return {
    name: server.name,
    description: server.description,
    transport: server.transport,
    command: server.command,
    args: server.args,
    url: server.url,
    env: server.env,
    allowedTools: server.allowedTools,
    enabled,
  };
}
