import type { MCPServerConfig } from '@wrongstack/contracts/types/config';

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

/** GitLab API: issues, PRs, repos, search, file operations. Requires GITLAB_PERSONAL_ACCESS_TOKEN. */
export const gitlabServer = (): MCPServerConfig => ({
  name: 'gitlab',
  description:
    'GitLab API — issues, merge requests, projects (requires GITLAB_PERSONAL_ACCESS_TOKEN)',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-gitlab'],
  passthroughEnv: ['GITLAB_PERSONAL_ACCESS_TOKEN', 'GITLAB_API_URL'],
  permission: 'confirm',
});

/**
 * PostgreSQL — database inspection and read-only query execution.
 * Provided by @modelcontextprotocol/server-postgres.
 */
export const postgresServer = (): MCPServerConfig => ({
  name: 'postgres',
  description: 'PostgreSQL database access — schema inspection and read-only queries',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-postgres'],
  passthroughEnv: ['DATABASE_URL', 'POSTGRES_CONNECTION_STRING'],
  permission: 'confirm',
});

/**
 * SQLite — database inspection and SQL execution via mcp-server-sqlite.
 */
export const sqliteServer = (): MCPServerConfig => ({
  name: 'sqlite',
  description: 'SQLite database inspection and queries (mcp-server-sqlite)',
  transport: 'stdio',
  command: 'uvx',
  args: ['mcp-server-sqlite', '--db-path', './database.db'],
  permission: 'confirm',
});

/**
 * Git — local repository operations, diffs, log, commit via mcp-server-git.
 */
export const gitServer = (): MCPServerConfig => ({
  name: 'git',
  description: 'Git repository inspection, diffs, log, commit (mcp-server-git)',
  transport: 'stdio',
  command: 'uvx',
  args: ['mcp-server-git', '--repository', '.'],
  permission: 'confirm',
});

/**
 * Memory — Knowledge Graph based persistent memory across conversations.
 * Provided by @modelcontextprotocol/server-memory.
 */
export const memoryServer = (): MCPServerConfig => ({
  name: 'memory',
  description: 'Knowledge Graph persistent memory (@modelcontextprotocol/server-memory)',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-memory'],
  // Persistent cross-conversation memory is a write surface the operator should
  // see at least once, and it is reached through the same npx path as every
  // other preset (security-check 2026-09-17).
  permission: 'confirm',
});

/**
 * Sequential Thinking — dynamic and reflective problem-solving tool.
 * Provided by @modelcontextprotocol/server-sequential-thinking.
 */
export const sequentialThinkingServer = (): MCPServerConfig => ({
  name: 'sequential-thinking',
  description:
    'Sequential thinking and problem solving (@modelcontextprotocol/server-sequential-thinking)',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
  // Lowest-risk of the three (no network, no filesystem), changed with them so
  // the newly added presets share one posture rather than three
  // (security-check 2026-09-17).
  permission: 'confirm',
});

/**
 * Puppeteer — browser automation via @modelcontextprotocol/server-puppeteer.
 */
export const puppeteerServer = (): MCPServerConfig => ({
  name: 'puppeteer',
  description: 'Browser automation via Puppeteer (navigate, click, screenshot, evaluate)',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-puppeteer'],
  permission: 'confirm',
});

/**
 * Docker — container and image management, logs, monitoring via docker-mcp.
 */
export const dockerServer = (): MCPServerConfig => ({
  name: 'docker',
  description: 'Docker container, image, and log management (docker-mcp)',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', 'docker-mcp'],
  permission: 'confirm',
});

/**
 * Fetch — web page fetcher and markdown conversion via mcp-server-fetch.
 */
export const fetchServer = (): MCPServerConfig => ({
  name: 'fetch',
  description: 'Web page fetching and markdown conversion (mcp-server-fetch)',
  transport: 'stdio',
  command: 'uvx',
  args: ['mcp-server-fetch'],
  // `confirm`, unlike the other read-only-looking presets: this server fetches
  // arbitrary URLs WITHOUT the SSRF controls in tools/src/_fetch-guard.ts that
  // the built-in `fetch` tool is held to — no private/loopback/metadata block,
  // no per-hop redirect revalidation, no pinned-resolution dial. Running it
  // unprompted would give prompt injection a cleaner egress path than the
  // guarded tool it superficially resembles (security-check 2026-09-17).
  permission: 'confirm',
});

/**
 * Sentry — error and crash tracking via sentry-mcp. Requires SENTRY_AUTH_TOKEN.
 */
export const sentryServer = (): MCPServerConfig => ({
  name: 'sentry',
  description: 'Sentry error and crash tracking (sentry-mcp, requires SENTRY_AUTH_TOKEN)',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', 'sentry-mcp'],
  passthroughEnv: ['SENTRY_AUTH_TOKEN'],
  permission: 'confirm',
});

/**
 * Block / Postgres database access preset (alias for postgresServer).
 * Uses official @modelcontextprotocol/server-postgres.
 */
export const blockServer = (): MCPServerConfig => ({
  ...postgresServer(),
  name: 'block',
  description: 'Postgres database access via SQL (@modelcontextprotocol/server-postgres)',
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
 * AWS knowledge base & API management — EC2, S3, Lambda, IAM, CloudFormation, CloudWatch.
 * Provided by @yawlabs/aws-mcp. Requires AWS credentials in environment or AWS SSO.
 */
export const awsServer = (): MCPServerConfig => ({
  name: 'aws',
  description: 'AWS — EC2, S3, Lambda, IAM, CloudFormation, CloudWatch (yawlabs/aws-mcp)',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@yawlabs/aws-mcp'],
  passthroughEnv: [
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_REGION',
    'AWS_SESSION_TOKEN',
    'AWS_PROFILE',
  ],
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

/**
 * Sentinel — security vulnerability scanning.
 * @deprecated sentinel.ai endpoint is unmaintained. Preserved for backward compatibility.
 */
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
  // Pinned rather than floating — see the note on `playwrightServer`.
  args: ['-y', '@z_ai/mcp-server@0.1.5'],
  env: { Z_AI_MODE: 'ZAI' },
  passthroughEnv: ['Z_AI_API_KEY'],
  allowedTools: [
    'ui_to_artifact',
    'image_analysis',
    'video_analysis',
    'extract_text_from_screenshot',
    'diagnose_error_screenshot',
    'understand_technical_diagram',
    'analyze_data_visualization',
    'ui_diff_check',
  ],
  permission: 'auto',
});

/** Z.AI Coding Plan Web Search — remote, read-only search capability. */
export const zaiWebSearchServer = (): MCPServerConfig => ({
  name: 'zai-web-search',
  description: 'Z.AI Coding Plan Web Search — current web results via webSearchPrime',
  transport: 'streamable-http',
  url: 'https://api.z.ai/api/mcp/web_search_prime/mcp',
  bearerTokenEnv: 'Z_AI_API_KEY',
  allowedTools: ['webSearchPrime'],
  permission: 'confirm',
});

/** Z.AI Coding Plan Web Reader — remote, read-only webpage extraction. */
export const zaiWebReaderServer = (): MCPServerConfig => ({
  name: 'zai-web-reader',
  description: 'Z.AI Coding Plan Web Reader — webpage content and metadata extraction',
  transport: 'streamable-http',
  url: 'https://api.z.ai/api/mcp/web_reader/mcp',
  bearerTokenEnv: 'Z_AI_API_KEY',
  allowedTools: ['webReader'],
  permission: 'confirm',
});

/**
 * Playwright — browser automation: navigate, snapshot, click, type, evaluate JS.
 * Spawns headless browser via Microsoft's official @playwright/mcp.
 */
export const playwrightServer = (): MCPServerConfig => ({
  name: 'playwright',
  description:
    'Browser automation — navigate, snapshot, click, type, evaluate JS (Microsoft Playwright)',
  transport: 'stdio',
  command: 'npx',
  // Pinned, not `@latest` (security-check 2026-09-17, DEP-NOTE-001): `npx`
  // resolves this at every server start, so a floating tag runs whatever was
  // published most recently — outside `pnpm-lock.yaml` and outside the
  // `minimumReleaseAge: 1440` cooldown that SECURITY.md calls the strongest
  // defence against a compromised-maintainer publish. Bumping this is a
  // deliberate review event, exactly like an `allowBuilds` entry.
  args: ['-y', '@playwright/mcp@0.0.81'],
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

// The project presets below launch through `wstack mcp serve <name>`: the
// separate `wstack-*-mcp` bins exist only in npm installs, never in the
// standalone binary, so a preset naming them could not start there.

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
  command: 'wstack',
  args: ['mcp', 'serve', 'requirement-intake', '--project-root', '.', '--writable'],
  permission: 'auto',
});

/**
 * WrongStack Kanban — inspect and manage durable project work through the
 * project-scoped Kanban IPC owner (`wstack-kanban-mcp`). The preset exposes
 * the writable manage tier (create/update/transition tasks, splitting,
 * assignment) but never `--destructive` (delete/merge/transfer). Mutations
 * touch durable project board state, so the permission defaults to `confirm`.
 */
export const kanbanServer = (): MCPServerConfig => ({
  name: 'kanban',
  description:
    'WrongStack Kanban — inspect and manage project work boards (project-scoped, manage tier, no destructive ops)',
  transport: 'stdio',
  command: 'wstack',
  args: ['mcp', 'serve', 'kanban', '--project-root', '.', '--writable'],
  permission: 'confirm',
});

/**
 * WrongStack Mailbox — coordinate with project agents through the existing
 * project-scoped mailbox IPC owner (`wstack-mailbox-mcp`). The preset exposes
 * the writable tier (send, receipts, self-presence) but never `--admin`
 * (maintenance + credential operations).
 *
 * `--actor` is mandatory: the child CLI exits with code 2 without it. The
 * default `external-agent` identity should be customized per external agent
 * (it is the authoritative identity for sends, receipts, and registration).
 */
export const mailboxServer = (): MCPServerConfig => ({
  name: 'mailbox',
  description:
    'WrongStack Mailbox — read and send project agent mail (project-scoped, no admin/credentials)',
  transport: 'stdio',
  command: 'wstack',
  args: [
    'mcp',
    'serve',
    'mailbox',
    '--project-root',
    '.',
    '--actor',
    'external-agent',
    '--writable',
  ],
  permission: 'auto',
});

/**
 * WrongStack Codebase Index — symbol search and dependency graphs over the
 * project's codebase index (`wstack-codebase-index-mcp`). The preset exposes
 * `--writable` so `codebase_index` (incremental/full rebuild) is available;
 * index rebuilds are CPU/disk work with no semantic risk.
 */
export const codebaseIndexServer = (): MCPServerConfig => ({
  name: 'codebase-index',
  description:
    'WrongStack Codebase Index — symbol search and dependency graphs (project-scoped, --writable)',
  transport: 'stdio',
  command: 'wstack',
  args: ['mcp', 'serve', 'codebase-index', '--project-root', '.', '--writable'],
  permission: 'auto',
});

/**
 * Resolve one `mcpServers` entry into a startable config.
 *
 * The record key IS the server name, and the documented way to turn a preset
 * on is the bare `mcpServers: { github: { enabled: true } }` — no `name`, no
 * `transport`, no `command`. Every boot path and `mcp_control enable` must
 * therefore merge the preset under the entry and stamp the key as the name;
 * callers that read `cfg.name` or skipped the merge started a server with an
 * undefined name or no command at all.
 */
export function resolveMcpServerConfig(
  name: string,
  cfg: Partial<MCPServerConfig> | undefined,
): MCPServerConfig | undefined {
  const presets = allServers();
  const preset = Object.hasOwn(presets, name) ? presets[name] : undefined;
  if (!preset && !cfg?.transport) return undefined;
  // A preset's catalog `enabled: false` is not the user's choice — only the
  // entry's own flag decides whether the server runs.
  const { enabled: _presetEnabled, ...presetBase } = preset ?? ({} as MCPServerConfig);
  return { ...presetBase, ...cfg, name } as MCPServerConfig;
}

/** Everything bundled — full set of built-in servers. Useful for `wstack mcp add --all`. */
export const allServers = (): Record<string, MCPServerConfig> => ({
  filesystem: { ...filesystemServer(), enabled: false },
  github: { ...githubServer(), enabled: false },
  gitlab: { ...gitlabServer(), enabled: false },
  postgres: { ...postgresServer(), enabled: false },
  sqlite: { ...sqliteServer(), enabled: false },
  git: { ...gitServer(), enabled: false },
  memory: { ...memoryServer(), enabled: false },
  'sequential-thinking': { ...sequentialThinkingServer(), enabled: false },
  puppeteer: { ...puppeteerServer(), enabled: false },
  context7: { ...context7Server(), enabled: false },
  fetch: { ...fetchServer(), enabled: false },
  'brave-search': { ...braveSearchServer(), enabled: false },
  docker: { ...dockerServer(), enabled: false },
  block: { ...blockServer(), enabled: false },
  everart: { ...everArtServer(), enabled: false },
  slack: { ...slackServer(), enabled: false },
  sentry: { ...sentryServer(), enabled: false },
  aws: { ...awsServer(), enabled: false },
  'google-maps': { ...googleMapsServer(), enabled: false },
  sentinel: { ...sentinelServer(), enabled: false },
  'zai-vision': { ...zaiVisionServer(), enabled: false },
  'zai-web-search': { ...zaiWebSearchServer(), enabled: false },
  'zai-web-reader': { ...zaiWebReaderServer(), enabled: false },
  'minimax-vision': { ...miniMaxVisionServer(), enabled: false },
  playwright: { ...playwrightServer(), enabled: false },
  ssh: { ...sshManagerServer(), enabled: false },
  kanban: { ...kanbanServer(), enabled: false },
  mailbox: { ...mailboxServer(), enabled: false },
  'codebase-index': { ...codebaseIndexServer(), enabled: false },
  'requirement-intake': { ...requirementIntakeServer(), enabled: false },
});
