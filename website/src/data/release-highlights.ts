/** Curated public release copy; the version guard requires a refresh on every release. */
export const releaseHighlights = {
  version: '1.7.10',
  title: 'Engines that start fast and stop on time.',
  summary:
    'Desktop engines start faster and no longer outlive their purpose. A boot that waited up to 10 s for the mailbox server now waits at most 1 s, project services stop after 15 minutes that no window uses them, and an engine whose session host died stops itself instead of running on.',
  socialDescription:
    'WrongStack 1.7.10: faster desktop engine starts, project services that stop when idle, and no engines left running after their host is gone.',
  cards: [
    {
      title: 'Faster starts',
      body: 'A boot no longer waits up to 10 s for an unresponsive mailbox server, and every start logs how long each step took.',
      href: '/interfaces',
      linkLabel: 'Explore the desktop',
    },
    {
      title: 'Idle services stop',
      body: 'Project services no window used for 15 minutes stop and start again on the next visit; supervised Kanban boards keep theirs.',
      href: '/interfaces',
      linkLabel: 'Explore the interfaces',
    },
    {
      title: 'No orphaned engines',
      body: 'An engine whose session host died stops itself within seconds instead of holding its memory until the next launch.',
      href: '/getting-started',
      linkLabel: 'Upgrade your installation',
    },
  ],
} as const;
