/** Curated public release copy; the version guard requires a refresh on every release. */
export const releaseHighlights = {
  version: '1.7.22',
  title: 'An IDE-style desktop workbench.',
  summary:
    "An IDE-style desktop workbench with a saved pane layout, ACP mode switching from WebUI and the desktop, a suspend-first Windows tree kill that no longer orphans a shell's command, and an edge-case round across approvals, YOLO gates, planning and display formatting.",
  socialDescription:
    'WrongStack 1.7.22: an IDE-style desktop workbench, ACP mode switching from WebUI and desktop, steadier Windows process stops and tighter YOLO gates.',
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
