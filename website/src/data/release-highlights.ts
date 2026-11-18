/** Curated public release copy; the version guard requires a refresh on every release. */
export const releaseHighlights = {
  version: '1.7.11',
  title: 'Whole frames and fresh screens.',
  summary:
    'The TUI keeps its frame whole in browser terminals and holds its layout in narrow panes. The desktop shows what each tool call touched and when its run activity happened, ChatGPT accounts gain gpt-6.2-sol and gpt-6.2-astra, and screens across the desktop, project pages, HQ and VibeUI ignore replies that arrive after they moved on.',
  socialDescription:
    'WrongStack 1.7.11: a TUI that stays whole in browser terminals, desktop tool calls that say what they touched, and screens that ignore stale replies.',
  cards: [
    {
      title: 'TUI everywhere',
      body: 'Emoji no longer tear the frame in VS Code, Codespaces, code-server, ttyd or the WebUI terminal, and the layout holds in narrow panes.',
      href: '/interfaces',
      linkLabel: 'Explore the interfaces',
    },
    {
      title: 'Readable runs',
      body: 'Desktop tool calls name what they touched, run activity is grouped by iteration with its time, and session details count every call.',
      href: '/interfaces',
      linkLabel: 'Explore the desktop',
    },
    {
      title: 'Fresh screens',
      body: 'A reply that arrives after its screen, board or request moved on is ignored instead of overwriting what you see.',
      href: '/getting-started',
      linkLabel: 'Upgrade your installation',
    },
  ],
} as const;
