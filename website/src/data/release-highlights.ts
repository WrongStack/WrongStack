/** Curated public release copy; the version guard requires a refresh on every release. */
export const releaseHighlights = {
  version: '1.4.0',
  title: 'The native desktop, all the way through.',
  summary:
    'Desktop v2 now covers conversations, files, Git review, Kanban, Goal and SDD runs, MCP, automation and memory, and passes its full native test matrix. HQ becomes a dashboard for many machines, and Goal runs stop at token and cost budgets.',
  socialDescription:
    'WrongStack 1.4.0: Desktop v2 at release depth, an HQ dashboard for many machines, Goal runs with token and cost budgets, and opt-in WrongMemory and WrongIndex services.',
  cards: [
    {
      title: 'Every workflow in the desktop app',
      body: 'Steer, rewind and resend conversations, stage single lines of a Git hunk, run a Kanban board as a Goal or SDD run, and use MCP tools as conversation steps, all from the native app.',
      href: '/interfaces',
      linkLabel: 'Compare the interfaces',
    },
    {
      title: 'One dashboard for many machines',
      body: 'HQ shows machine health history, alert limits, labels and spend per label, and can start a session on a machine from the dashboard.',
      href: '/features',
      linkLabel: 'Explore HQ',
    },
    {
      title: 'Goal runs with a budget',
      body: 'Goal runs stop at provider-token and USD cost limits priced from the model catalog, and record every phase verification attempt.',
      href: '/features',
      linkLabel: 'See the feature set',
    },
  ],
} as const;
