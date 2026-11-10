/** Curated public release copy; the version guard requires a refresh on every release. */
export const releaseHighlights = {
  version: '1.5.6',
  title: 'WrongStack’s slash commands in your editor over ACP.',
  summary:
    'An editor connected over ACP lists WrongStack’s slash commands in its / menu and runs them from a prompt; anything that does more than read asks first. An ACP or WrongForge leader now receives the conversation alone, without WrongStack’s prompt scaffolding on your message, and the session story charts the context it really holds.',
  socialDescription:
    'WrongStack 1.5.6: WrongStack’s slash commands in your editor over ACP, ACP leaders get only your conversation, the session story shows their real context, and slow MCP servers connect.',
  cards: [
    {
      title: 'Slash commands over ACP',
      body: 'wstack acp announces its commands to the editor, so /git, /tuneup, /permissions, the skill, prompt and hunt commands appear in its / menu. Read-only commands answer at once; a command that changes settings or files asks through the editor’s permission prompt, since a prompt can be written by a model.',
      href: '/acp',
      linkLabel: 'Explore ACP',
    },
    {
      title: 'ACP leaders get only the conversation',
      body: 'An agent leading the session runs its own system prompt and tools. WrongStack no longer attaches its plan, ledger, memory and other scaffolding to your message for it, and keeps only mail and the next-steps instruction.',
      href: '/acp',
      linkLabel: 'See how ACP works',
    },
    {
      title: 'A session story that tells the truth',
      body: 'For an ACP leader the context chart shows what the agent reports: its context fill and window, and the turn’s cache use, instead of a request WrongStack composed and never sent.',
      href: '/fleet',
      linkLabel: 'See the fleet',
    },
  ],
} as const;
