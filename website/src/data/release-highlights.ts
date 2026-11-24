/** Curated public release copy; the version guard requires a refresh on every release. */
export const releaseHighlights = {
  version: '1.7.20',
  title: 'HQ key vault for your machines.',
  summary:
    "HQ becomes a central key vault that hands provider keys and OAuth profiles to enrolled machines, ACP workers share one project MCP gateway, and a round of security, Chronicle and audit fixes.",
  socialDescription:
    "WrongStack 1.7.20: HQ hands provider keys and OAuth profiles to enrolled machines, ACP workers share one MCP gateway, and a security round.",
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
