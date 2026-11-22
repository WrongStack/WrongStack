/** Curated public release copy; the version guard requires a refresh on every release. */
export const releaseHighlights = {
  version: '1.7.16',
  title: 'ACP session modes, MCP instructions.',
  summary:
    "Editors and orchestrators that drive WrongStack over ACP choose how much it does unasked: default, plan, auto-edit or yolo, from session/set_mode or a start flag, with permission prompts that say what 'always' covers. MCP servers' own instructions reach the model, Code Intelligence moves into its own package, and a round of guard fixes closes more ways around the safety gates.",
  socialDescription:
    "WrongStack 1.7.16: ACP clients choose a session mode, MCP servers' own instructions reach the model, and Code Intelligence gets its own package.",
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
