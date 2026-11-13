/** Curated public release copy; the version guard requires a refresh on every release. */
export const releaseHighlights = {
  version: '1.6.3',
  title: 'Decisions your agents keep.',
  summary:
    'Agents propose architecture decisions and only your review makes them binding, so later sessions and ACP agents work inside the choices you made. Design gains fourteen new kits with real material and an open-licensed photo library, session rewinds respect branches, and plugin reloads roll back on failure.',
  socialDescription:
    'WrongStack 1.6.3: reviewed architecture decisions that follow every agent in the project, fourteen new design kits with an open-licensed photo library, and safer session rewinds and plugin reloads.',
  cards: [
    {
      title: 'Architecture decisions',
      body: 'Review an agent’s proposal revision by revision in the ADRs panel or with /adr; accepted decisions reach every later session and ACP agent.',
      href: '/getting-started',
      linkLabel: 'Get started',
    },
    {
      title: 'Fourteen new design kits',
      body: 'Each kit records its font classes, axes and photo treatment, and designs pick credited Wikimedia Commons photographs that fit the brief.',
      href: '/getting-started',
      linkLabel: 'Try design',
    },
    {
      title: 'Rewinds and reloads you can trust',
      body: 'Rewinds cut only the active branch, and a plugin reload validates the new module first and restores the old one if activation fails.',
      href: '/getting-started',
      linkLabel: 'Install WrongStack',
    },
  ],
} as const;
