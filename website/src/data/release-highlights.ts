/** Curated public release copy; the version guard requires a refresh on every release. */
export const releaseHighlights = {
  version: '1.5.3',
  title: 'The desktop catches up on the rest of what the CLI does.',
  summary:
    'Every worker of a desktop conversation gets its agent tab beside the leader, with a fleet gauge showing how many run and how many spawns are left. An ACP agent such as Claude Code can lead a conversation, the desktop says once when a newer WrongStack is out, and a configured exec sandbox is now enforced in every host.',
  socialDescription:
    'WrongStack 1.5.3: every agent of a desktop conversation gets its tab with a fleet gauge, ACP agents lead desktop conversations, and a configured exec sandbox is enforced.',
  cards: [
    {
      title: 'Every agent gets its tab',
      body: 'A conversation’s workers each get an agent tab beside the leader, with their transcript or, failing that, their output so far. A fleet gauge shows how many workers run against the ceiling and how many spawns the fleet budget has left.',
      href: '/fleet',
      linkLabel: 'See the fleet',
    },
    {
      title: 'ACP agents lead desktop conversations',
      body: 'A profile whose provider is acp, for example after /model acp/claude-code, now opens in the desktop. The ACP leader appears in the model pickers, tool approvals reach its tab, and its agent sessions close with the engine.',
      href: '/acp',
      linkLabel: 'Explore ACP',
    },
    {
      title: 'tools.sandbox is enforced',
      body: 'The exec sandbox policy in config.tools.sandbox was declared in the wrong config block and never reached the sandbox. The CLI, the WebUI and the desktop engine now apply the configured mode and tier when they register their tools.',
      href: '/security',
      linkLabel: 'Read about security',
    },
  ],
} as const;
