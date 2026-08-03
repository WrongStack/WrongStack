import type { MCPServerConfig } from '../types/config.js';

/**
 * Built-in MCP server presets available to all WrongStack users out of the box.
 * These servers must be explicitly enabled in config (disabled by default).
 *
 * To enable: set `mcpServers: { serverName: { enabled: true } }` in your config.
 *
 * Some servers require environment variables or additional config — see notes below.
 *
 * Transport types:
 *   stdio       — spawns a local npm package binary via child_process
 *   sse         — HTTP SSE endpoint (client POSTs requests)
 *   streamable-http — session-based HTTP with NDJSON responses
 */

/** Filesystem access: read, write, list, search, tree. Good for exploring projects. */
export const filesystemServer = (): MCPServerConfig => ({
  name: 'filesystem',
  description: 'Read, write, and navigate the local filesystem (read-heavy tools)',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
  permission: 'confirm',
});

/** GitHub API: issues, PRs, repos, search, file operations. Requires GITHUB_PERSONAL_ACCESS_TOKEN. */
export const githubServer = (): MCPServerConfig => ({
  name: 'github',
  description:
    'GitHub API — issues, PRs, repos, search, file ops (requires GITHUB_PERSONAL_ACCESS_TOKEN)',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-github'],
  passthroughEnv: ['GITHUB_PERSONAL_ACCESS_TOKEN', 'GITHUB_TOKEN'],
  permission: 'confirm',
});

/**
 * Context7 — codebase-aware documentation and Q&A using context from your code.
 * Live documentation for any library, grounded in your actual versions.
 */
export const context7Server = (): MCPServerConfig => ({
  name: 'context7',
  description: 'Codebase-aware documentation and Q&A (context7.ai)',
  transport: 'streamable-http',
  url: 'https://mcp.context7.com/mcp',
  permission: 'confirm',
});

/**
 * Brave Search — web search via Brave Browser's API.
 * Requires BRAVE_SEARCH_API_KEY. Free tier: 2,000 queries/month.
 * Sign up at https://api.search.brave.com/
 */
export const braveSearchServer = (): MCPServerConfig => ({
  name: 'brave-search',
  description: 'Web search (Brave). Requires BRAVE_SEARCH_API_KEY — free tier 2k queries/month',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-brave-search'],
  passthroughEnv: ['BRAVE_SEARCH_API_KEY'],
  permission: 'confirm',
});

/**
 * Block (Block, Inc.) — Postgres database access via SQL.
 * Useful for running queries against a connected database during development.
 */
export const blockServer = (): MCPServerConfig => ({
  name: 'block',
  description: 'Postgres database access via SQL (Block MCP server)',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-block'],
  permission: 'confirm',
});

/**
 * EverArt — AI image generation via various providers.
 * Requires EVERART_API_KEY.
 */
export const everArtServer = (): MCPServerConfig => ({
  name: 'everart',
  description: 'AI image generation (EverArt). Requires EVERART_API_KEY',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-everart'],
  passthroughEnv: ['EVERART_API_KEY'],
  permission: 'confirm',
});

/**
 * Slack — messaging, channels, search.
 * Requires SLACK_BOT_TOKEN and either SLACK_TEAM_ID or SLACK_USER_TOKEN.
 */
export const slackServer = (): MCPServerConfig => ({
  name: 'slack',
  description: 'Slack — messaging, channels, search. Requires SLACK_BOT_TOKEN + SLACK_TEAM_ID',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-slack'],
  passthroughEnv: ['SLACK_BOT_TOKEN', 'SLACK_TEAM_ID'],
  permission: 'confirm',
});

/**
 * AWS knowledge base — EC2, S3, Lambda, IAM, CloudFormation, cost management.
 * Requires AWS access key + secret in environment.
 */
export const awsServer = (): MCPServerConfig => ({
  name: 'aws',
  description: 'AWS — EC2, S3, Lambda, IAM, CloudFormation, costs. Requires AWS credentials',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-aws'],
  passthroughEnv: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION', 'AWS_SESSION_TOKEN'],
  permission: 'confirm',
});

/**
 * Google Maps — directions, distance matrix, geocoding, places.
 * Requires GOOGLE_MAPS_API_KEY.
 */
export const googleMapsServer = (): MCPServerConfig => ({
  name: 'google-maps',
  description: 'Google Maps — directions, geocoding, places. Requires GOOGLE_MAPS_API_KEY',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-google-maps'],
  passthroughEnv: ['GOOGLE_MAPS_API_KEY'],
  permission: 'confirm',
});

/** Sentinel — security vulnerability scanning (sentinel-labs). */
export const sentinelServer = (): MCPServerConfig => ({
  name: 'sentinel',
  description: 'Security vulnerability scanning (Sentinel)',
  transport: 'streamable-http',
  url: 'https://mcp.sentinel.ai',
  permission: 'deny', // security tool — require explicit confirmation
});

/**
 * Z.AI Vision MCP — image understanding fallback for text-only models.
 * Requires Z_AI_API_KEY. Tools are read-only and safe to run automatically.
 */
export const zaiVisionServer = (): MCPServerConfig => ({
  name: 'zai-vision',
  description: 'Z.AI Vision MCP — image analysis and screenshot understanding',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@z_ai/mcp-server@latest'],
  env: { Z_AI_MODE: 'ZAI' },
  passthroughEnv: ['Z_AI_API_KEY'],
  allowedTools: [
    'image_analysis',
    'extract_text_from_screenshot',
    'diagnose_error_screenshot',
    'understand_technical_diagram',
    'analyze_data_visualization',
    'ui_diff_check',
  ],
  permission: 'auto',
});

/**
 * Playwright — browser automation: navigate, click, type, screenshot, evaluate JS.
 * Spawns a headless Chromium browser via @modelcontextprotocol/server-playwright.
 * Tools can read and interact with live web pages — permission defaults to
 * `confirm` because form submission / DOM mutation is possible.
 */
export const playwrightServer = (): MCPServerConfig => ({
  name: 'playwright',
  description:
    'Browser automation — navigate, screenshot, click, type, evaluate JS (headless Chromium)',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-playwright'],
  permission: 'confirm',
});

/**
 * MiniMax Token Plan MCP — search + understand_image.
 * This preset exposes only the read-only image understanding tool by default.
 * Requires MINIMAX_API_KEY and uvx on PATH.
 */
export const miniMaxVisionServer = (): MCPServerConfig => ({
  name: 'minimax-vision',
  description: 'MiniMax MCP — image understanding via understand_image',
  transport: 'stdio',
  command: 'uvx',
  args: ['minimax-coding-plan-mcp', '-y'],
  env: {
    MINIMAX_MCP_BASE_PATH: './.wrongstack/minimax-output',
    MINIMAX_API_HOST: 'https://api.minimax.io',
    MINIMAX_API_RESOURCE_MODE: 'url',
  },
  passthroughEnv: ['MINIMAX_API_KEY'],
  allowedTools: ['understand_image'],
  permission: 'auto',
});

/**
 * SSH Manager — remote SSH execution, file transfer, tunnels, health checks, and deployment ops.
 * Server credentials are intentionally NOT embedded here. Configure hosts via mcp-ssh-manager's
 * env/TOML config (for example SSH_SERVER_<NAME>_HOST, USER, KEYPATH/PASSWORD) or ssh-agent.
 */
export const sshManagerServer = (): MCPServerConfig => ({
  name: 'ssh',
  description:
    'Remote SSH management — execute commands, transfer files, tunnels, health checks (mcp-ssh-manager)',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', 'mcp-ssh-manager'],
  env: {
    MCP_SSH_COMPACT_JSON: 'true',
    MCP_SSH_DEFAULT_TIMEOUT: '120000',
  },
  permission: 'confirm',
  requestTimeoutMs: 180_000,
});

/**
 * WrongStack Requirements Intake — list intake records and file + submit new
 * ones against the project's intake store (`wstack-requirement-intake-mcp`).
 * Project-scoped: resolves the project from the spawn cwd (`--project-root .`);
 * customize the arg for absolute paths. Tools are structured domain tools
 * (list/submit) with no file, shell, or network surface, so the permission
 * defaults to `auto`.
 */
export const requirementIntakeServer = (): MCPServerConfig => ({
  name: 'requirement-intake',
  description:
    'WrongStack Requirements Intake — list intake records and file new ones (project-scoped, --writable)',
  transport: 'stdio',
  command: 'wstack-requirement-intake-mcp',
  args: ['--project-root', '.', '--writable'],
  permission: 'auto',
});

/** Everything bundled — full set of built-in servers. Useful for `wstack mcp add --all`. */
export const allServers = (): Record<string, MCPServerConfig> => ({
  filesystem: { ...filesystemServer(), enabled: false },
  github: { ...githubServer(), enabled: false },
  context7: { ...context7Server(), enabled: false },
  'brave-search': { ...braveSearchServer(), enabled: false },
  block: { ...blockServer(), enabled: false },
  everart: { ...everArtServer(), enabled: false },
  slack: { ...slackServer(), enabled: false },
  aws: { ...awsServer(), enabled: false },
  'google-maps': { ...googleMapsServer(), enabled: false },
  sentinel: { ...sentinelServer(), enabled: false },
  'zai-vision': { ...zaiVisionServer(), enabled: false },
  'minimax-vision': { ...miniMaxVisionServer(), enabled: false },
  playwright: { ...playwrightServer(), enabled: false },
  ssh: { ...sshManagerServer(), enabled: false },
  'requirement-intake': { ...requirementIntakeServer(), enabled: false },
});
