/** Curated public release copy; the version guard requires a refresh on every release. */
export const releaseHighlights = {
  version: '1.7.17',
  title: 'Desktop installers are back.',
  summary:
    "The desktop installers are back on every platform, with all of 1.7.16: ACP clients choose how much WrongStack does unasked (default, plan, auto-edit or yolo), MCP servers' own instructions reach the model, and Code Intelligence has its own package.",
  socialDescription:
    "WrongStack 1.7.17: the desktop installers are back, with 1.7.16's ACP session modes and MCP server instructions.",
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
