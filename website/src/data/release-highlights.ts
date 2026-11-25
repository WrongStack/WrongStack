/** Curated public release copy; the version guard requires a refresh on every release. */
export const releaseHighlights = {
  version: '1.7.21',
  title: 'ACP leaders, fully native.',
  summary:
    "ACP leaders run the agent's own slash commands, modes, plans and subagents, HQ vault leases keep provider keys in memory only, machines can push their providers to HQ for approval, and a repository-wide input-validation hardening round.",
  socialDescription:
    "WrongStack 1.7.21: ACP leaders run the agent's own commands, modes and plans, HQ leases keep keys in memory, and an input-hardening round.",
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
