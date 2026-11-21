/** Curated public release copy; the version guard requires a refresh on every release. */
export const releaseHighlights = {
  version: '1.7.14',
  title: 'Tighter guards, steadier desktop.',
  summary:
    'The safety gates now catch git worktree remove --force, abbreviated long options on delete, reset and restore, and package names spelled the way PyPI and crates.io fold them; Anthropic admin keys are redacted. The desktop keeps your page and open file between project views, shows a reloaded conversation\'s questions once, and sends a stop to the right engine.',
  socialDescription:
    'WrongStack 1.7.14: safety guards catch abbreviated options and forced worktree removal, and the desktop keeps your page, questions and stops on track.',
  cards: [
    {
      title: 'Tighter guards',
      body: 'Forced worktree removal, abbreviated long options and registry-folded package names are caught; Anthropic admin keys are redacted.',
      href: '/getting-started',
      linkLabel: 'Upgrade your installation',
    },
    {
      title: 'Steadier desktop',
      body: 'Project views keep their page and open file, reloaded conversations show their questions once, and stops reach the right engine.',
      href: '/interfaces',
      linkLabel: 'Explore the desktop',
    },
    {
      title: 'Checked symbol anchors',
      body: 'A SAGE memory anchored to a symbol can check the body it was written against, so a changed function is noticed.',
      href: '/interfaces',
      linkLabel: 'Explore the interfaces',
    },
  ],
} as const;
