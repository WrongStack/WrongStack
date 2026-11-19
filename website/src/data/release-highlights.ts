/** Curated public release copy; the version guard requires a refresh on every release. */
export const releaseHighlights = {
  version: '1.7.12',
  title: 'Safer deletes, fresher screens.',
  summary:
    'The YOLO delete gate now catches abbreviated rm long options, pastes in the TUI land in the open field, and screens across the WebUI, VibeUI, the project pages and the desktop ignore replies that belong to an older query or request. The desktop also gains an Agent office shortcut.',
  socialDescription:
    'WrongStack 1.7.12: the YOLO delete gate catches abbreviated rm options, late replies stop overwriting what you see, and the desktop gains an Agent office shortcut.',
  cards: [
    {
      title: 'Safer deletes',
      body: 'Abbreviated rm long options are classified destructive, so YOLO mode asks before running them.',
      href: '/getting-started',
      linkLabel: 'Upgrade your installation',
    },
    {
      title: 'Fresh screens',
      body: 'File pickers, git changes, diffs and project pages show the answer to your latest request, never a late reply to an older one.',
      href: '/interfaces',
      linkLabel: 'Explore the interfaces',
    },
    {
      title: 'Agent office shortcut',
      body: 'Open the Agent office from the desktop top bar; drafts and engine stop/reconnect hold up under failures.',
      href: '/interfaces',
      linkLabel: 'Explore the desktop',
    },
  ],
} as const;
