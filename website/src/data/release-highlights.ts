/** Curated public release copy; the version guard requires a refresh on every release. */
export const releaseHighlights = {
  version: '1.7.9',
  title: 'A desktop that keeps up.',
  summary:
    'The desktop stays smooth while answers stream and while typing, reconnects a stopped conversation through the spare engine already waiting in its folder, and opens long conversations faster. A session inspector shows each worker beside the leader transcript, projects can be reordered and removed, and a BTW note reaches the leader as a same-session instruction.',
  socialDescription:
    'WrongStack 1.7.9: smooth desktop conversations, reconnects through a waiting engine, a session inspector, reorderable projects, and BTW as a same-session instruction.',
  cards: [
    {
      title: 'Smooth while it streams',
      body: 'Streaming answers and typing repaint only what changed, and a stopped conversation resumes in the engine already waiting for it.',
      href: '/interfaces',
      linkLabel: 'Explore the interfaces',
    },
    {
      title: 'See every worker',
      body: "A session inspector shows each worker's transcript and the plan beside the leader, without taking over the composer.",
      href: '/interfaces',
      linkLabel: 'Explore the desktop',
    },
    {
      title: 'BTW that lands',
      body: 'A BTW note reaches the leader as a user instruction in the same session and is not lost when a turn ends.',
      href: '/getting-started',
      linkLabel: 'Upgrade your installation',
    },
  ],
} as const;
