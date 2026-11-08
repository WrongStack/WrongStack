/** Curated public release copy; the version guard requires a refresh on every release. */
export const releaseHighlights = {
  version: '1.5.2',
  title: 'The desktop engine does what the CLI host does.',
  summary:
    'Desktop v2’s pages were complete, but the engine behind them skipped work only the CLI started. Desktop conversations are now recorded for Session Story, the CLI’s plugins and hooks run in the desktop, and the WebUI’s notification center and tool statistics come with them. Every release also carries the desktop installers, and wstack desktop installs and opens them.',
  socialDescription:
    'WrongStack 1.5.2: the desktop engine records Session Story history, runs the CLI’s plugins and hooks, and brings the WebUI’s notification center and tool statistics to the desktop.',
  cards: [
    {
      title: 'History that survives the desktop',
      body: 'Desktop conversations are recorded in Chronicle, so Session Story fills in for them, and subagent transcripts are still there after a reopen. HQ can steer desktop sessions.',
      href: '/interfaces',
      linkLabel: 'Compare the interfaces',
    },
    {
      title: 'The CLI’s plugins and hooks, in the desktop',
      body: 'The desktop engine loads the CLI’s plugins, the injection shield and secret scanner included, runs config.hooks with policy hooks, and builds the same autonomy, plan and Code Atlas prompt sections.',
      href: '/plugins',
      linkLabel: 'Browse the plugins',
    },
    {
      title: 'Desktop installers on every release',
      body: 'Each release ships a Windows setup.exe, a macOS .dmg and Linux .deb and .rpm packages with the engine bundled. wstack desktop install downloads, verifies and runs the one for this platform.',
      href: '/getting-started',
      linkLabel: 'Get started',
    },
  ],
} as const;
