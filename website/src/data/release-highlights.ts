/** Curated public release copy; the version guard requires a refresh on every release. */
export const releaseHighlights = {
  version: '1.7.24',
  title: 'Workflow tools that fill in inputs from the project.',
  summary:
    'Workflow plugin tools fill in changed files, packages and manifests from the project when the model leaves them out. Lint, test and type gates check the code that was edited, Kanban Companion gets a project-wide switch, and the TUI gains a memory browser.',
  socialDescription:
    'WrongStack 1.7.24: workflow tools fill in inputs from the project, plugin gates check edited code, a Kanban Companion switch and a TUI memory browser.',
  cards: [
    {
      title: 'Workflow plugins',
      body: 'Omitted inputs come from the working-tree change, the workspace packages or the conventional root file, and each result says which one it used.',
      href: '/plugins',
      linkLabel: 'Browse the plugins',
    },
    {
      title: 'Gates that check your edit',
      body: 'lint-gate, test-runner-gate and type-gate check the file you just edited, and import-organizer applies only the import rules.',
      href: '/plugins',
      linkLabel: 'See the plugin gates',
    },
    {
      title: 'Kanban Companion switch',
      body: 'Turn the companion on or off for a whole project from WebUI or Desktop settings. Turning it off cancels its pending board writes.',
      href: '/getting-started',
      linkLabel: 'Upgrade your installation',
    },
  ],
} as const;
