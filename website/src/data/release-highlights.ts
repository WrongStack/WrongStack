/** Curated public release copy; the version guard requires a refresh on every release. */
export const releaseHighlights = {
  version: '1.7.13',
  title: 'A chat that reads as steps.',
  summary:
    'The desktop conversation shows each tool call as one line with its target, time and result, a plan card, live command output and the files a turn changed. Approvals are an inline banner with Y/N shortcuts, Brain, Chimera, council and fallback events share one card style, and Bun projects get bun add, audit and outdated.',
  socialDescription:
    'WrongStack 1.7.13: the desktop chat reads as steps with inline approvals and event cards, and Bun projects get bun install, audit and outdated.',
  cards: [
    {
      title: 'Chat as steps',
      body: 'Searched, Read, Edited, Ran: one line per step with its target and time, a plan card with progress and the files each turn changed.',
      href: '/interfaces',
      linkLabel: 'Explore the desktop',
    },
    {
      title: 'Inline approvals',
      body: 'A banner names the whole command; allow or deny with Y and N, with arguments and remembered scope one click away.',
      href: '/interfaces',
      linkLabel: 'Explore the interfaces',
    },
    {
      title: 'Bun projects',
      body: 'Install, audit and outdated run Bun for Bun projects, and the vulnerability gate audits each install where it ran.',
      href: '/getting-started',
      linkLabel: 'Upgrade your installation',
    },
  ],
} as const;
