/** Curated public release copy; the version guard requires a refresh on every release. */
export const releaseHighlights = {
  version: '1.7.4',
  title: 'Hardened where it counts.',
  summary:
    'Timeouts longer than about 24.8 days no longer fire after 1 ms, path guards follow symlinked folders and reject drive-relative and traversing paths, user-named keys cannot reach object prototype members, and malformed JSON or empty responses produce errors instead of crashes. ACP releases sessions it refused, and lint gates recover from a failed probe.',
  socialDescription:
    'WrongStack 1.7.4: long timeouts that wait as long as asked, path guards that follow symlinked folders, and input handling that no longer crashes on malformed data.',
  cards: [
    {
      title: 'Timeouts that wait',
      body: 'Delays above the 32-bit timer limit are capped or chunked, so a long timeout no longer fails after 1 ms.',
      href: '/getting-started',
      linkLabel: 'Upgrade your installation',
    },
    {
      title: 'Paths that stay inside',
      body: 'New files under symlinked folders, Windows drive-relative paths and traversing prompt ids cannot escape the project.',
      href: '/security',
      linkLabel: 'Explore the safeguards',
    },
    {
      title: 'Input that does not crash',
      body: 'Malformed JSON, empty bodies and names such as toString produce errors or fallbacks; ACP releases sessions it refused.',
      href: '/interfaces',
      linkLabel: 'Explore the interfaces',
    },
  ],
} as const;
