/** Curated public release copy; the version guard requires a refresh on every release. */
export const releaseHighlights = {
  version: '1.6.1',
  title: 'A desktop app that keeps up.',
  summary:
    'Project journals in the desktop app stop growing by gigabytes, a project opens without replaying its whole history, and an engine boots without starting a process for every language server and linter. The conversation screen picks up the WebUI’s quieter message actions, one tab strip and a tidier composer; /tree fold takes notes, and Chimera skips model tokens on docs-only reviews.',
  socialDescription:
    'WrongStack 1.6.1: a faster desktop app with small project journals, quick project open and engine boot, a conversation screen closer to the WebUI, /tree fold notes, and token-free Chimera pre-screens.',
  cards: [
    {
      title: 'Journals that stay small',
      body: 'Status and supervisor snapshots are throttled and deduplicated before they are written, and a project opens from the end of its journal instead of replaying all of it.',
      href: '/getting-started',
      linkLabel: 'Install WrongStack',
    },
    {
      title: 'An engine that boots sooner',
      body: 'On Windows, language servers and linters are found by scanning PATH instead of starting a process for each, and the linter is probed only when it first runs.',
      href: '/getting-started',
      linkLabel: 'Get started',
    },
    {
      title: 'A calmer conversation screen',
      body: 'Message actions appear on hover, conversation and view tabs share one strip, and the composer keeps its controls on one row while there is room.',
      href: '/getting-started',
      linkLabel: 'Try the desktop app',
    },
  ],
} as const;
