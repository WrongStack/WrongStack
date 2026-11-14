/** Curated public release copy; the version guard requires a refresh on every release. */
export const releaseHighlights = {
  version: '1.7.0',
  title: 'Keep your workspace moving.',
  summary:
    'Desktop conversations take their names from your first prompt and can be renamed in place. Code Atlas loads larger graphs in the desktop and WebUI, plugins can be added and removed from WebUI Settings, Chronicle reuses its counts, and VibeUI makes keyboard navigation and narrow screens easier to use.',
  socialDescription:
    'WrongStack 1.7.0: named desktop conversations, larger Code Atlas graphs, plugin management in WebUI Settings, faster Chronicle refreshes and a refined VibeUI.',
  cards: [
    {
      title: 'Conversations you can find',
      body: 'Desktop tabs take a name from the first prompt. Double-click or press F2 to rename one; long titles stay compact and show their full text on hover.',
      href: '/interfaces',
      linkLabel: 'Explore the interfaces',
    },
    {
      title: 'Code Atlas for larger projects',
      body: 'Large graphs arrive in consistent chunks, keeping their nodes and edges together. The desktop and WebUI share the same loader and clearer recovery guidance.',
      href: '/interfaces',
      linkLabel: 'Find your workspace',
    },
    {
      title: 'Plugins from WebUI Settings',
      body: 'Add or remove a plugin and inspect configured and official lists in Settings → Context. The engine reports the result and tells you when a restart is needed.',
      href: '/plugins',
      linkLabel: 'Explore plugins',
    },
  ],
} as const;
