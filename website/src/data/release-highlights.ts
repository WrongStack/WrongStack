/** Curated public release copy; the version guard requires a refresh on every release. */
export const releaseHighlights = {
  version: '1.5.0',
  title: 'The same screens and commands, wherever you work.',
  summary:
    'Desktop v2 now renders the WebUI’s own SAGE memory, Kanban board, Code Atlas, agent office and Session Story, and shows every screen in seven languages. The TUI’s slash commands run on the engine, so the desktop composer and the WebUI chat can commit, push, spawn workers and run /tuneup.',
  socialDescription:
    'WrongStack 1.5.0: Desktop v2 renders the WebUI’s project surfaces in seven languages, the TUI’s slash commands run from the desktop and the WebUI, and WrongMemory reaches Linux and macOS.',
  cards: [
    {
      title: 'One set of project screens',
      body: 'The desktop and the WebUI render the same SAGE memory, Kanban board, Code Atlas, agent office, Session Story and analytics components, and desktop-only tools keep their own slots.',
      href: '/interfaces',
      linkLabel: 'Compare the interfaces',
    },
    {
      title: 'The TUI’s commands, everywhere',
      body: '/git, /commit, /push, /security, /spawn, /delegate, /acp, /tuneup and the skill and prompt libraries run from the desktop composer and the WebUI chat. Commands that change data ask first.',
      href: '/commands',
      linkLabel: 'Browse the commands',
    },
    {
      title: 'Memory that follows your checkout',
      body: 'WrongMemory installs on Linux and macOS, and a linked worktree binds to its own checkout, so recall and verification judge the files that worktree actually has.',
      href: '/memory',
      linkLabel: 'Explore SAGE memory',
    },
  ],
} as const;
