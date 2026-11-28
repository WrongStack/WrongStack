/** Curated public release copy; the version guard requires a refresh on every release. */
export const releaseHighlights = {
  version: '1.7.26',
  title: 'More of GitHub, and a terminal that reconnects.',
  summary:
    'Open issues and pull requests, search GitHub and show your own items from the WebUI GitHub view. The integrated terminal keeps its shell through short disconnects, and the default secret-scanner stops blocking ordinary source and UI labels.',
  socialDescription:
    'WrongStack 1.7.26: open and search GitHub issues and pull requests from WebUI, a terminal that survives reconnects and fewer false secret blocks.',
  cards: [
    {
      title: 'Open and search GitHub items',
      body: 'Start an issue or a pull request from the checked-out branch, search GitHub with the view\'s filters, and narrow a tab to items you created, are assigned or must review.',
      href: '/interfaces',
      linkLabel: 'Explore the interfaces',
    },
    {
      title: 'Terminal reconnect',
      body: 'A dropped WebUI connection no longer kills the shell: the tab reattaches within a minute and replays the output it missed.',
      href: '/interfaces',
      linkLabel: 'See the WebUI',
    },
    {
      title: 'Fewer false secret blocks',
      body: 'The default secret-scanner keeps each pattern\'s own flags and leaves translated UI labels alone, while real-looking keys are still blocked.',
      href: '/getting-started',
      linkLabel: 'Upgrade your installation',
    },
  ],
} as const;
