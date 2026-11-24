/** Curated public release copy; the version guard requires a refresh on every release. */
export const releaseHighlights = {
  version: '1.7.19',
  title: 'Desktop installers are back.',
  summary:
    "A direct ChatGPT sign-in shows its plan and app quota again through the Codex CLI login, WrongForge and ACP switches keep the leader streaming, and a round of core, tool, ACP, SAGE and Windows hardening fixes.",
  socialDescription:
    "WrongStack 1.7.19: a direct ChatGPT sign-in shows its plan quota again, and a round of core, tool and Windows hardening fixes.",
  cards: [
    {
      title: 'ACP session modes',
      body: 'default, plan, auto-edit and yolo through session/set_mode or wstack acp serve --mode; yolo still asks before destructive calls.',
      href: '/acp',
      linkLabel: 'Use WrongStack over ACP',
    },
    {
      title: 'MCP server instructions',
      body: "Each MCP server's initialize instructions reach the system prompt, over ACP and with --mcp-config.",
      href: '/interfaces',
      linkLabel: 'Explore the interfaces',
    },
    {
      title: 'Tighter guards',
      body: 'Pipeline-fed kills, cross-worktree git commands and quoted secret values no longer slip past the gates.',
      href: '/getting-started',
      linkLabel: 'Upgrade your installation',
    },
  ],
} as const;
