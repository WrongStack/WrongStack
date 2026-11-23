/** Curated public release copy; the version guard requires a refresh on every release. */
export const releaseHighlights = {
  version: '1.7.18',
  title: 'Desktop installers are back.',
  summary:
    "The desktop installers are back on every platform, with all of 1.7.16: ACP session modes, MCP server instructions and the Code Intelligence package. Quick sessions pin their tool surface and shell, and state files are owner-only on Windows.",
  socialDescription:
    "WrongStack 1.7.18: desktop installers are back, Quick sessions pin their tool surface, and state files are owner-only on Windows.",
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
