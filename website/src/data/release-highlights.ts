/** Curated public release copy; the version guard requires a refresh on every release. */
export const releaseHighlights = {
  version: '1.5.4',
  title: 'Any editor can run WrongStack as its ACP agent.',
  summary:
    'wstack acp starts on a fresh machine and offers a login, so an editor that installs it can sign in without leaving the editor, and the session’s model is chosen from the editor’s own model picker. ACP agents that WrongStack drives now reach files outside the project when WrongStack’s own tools may, and the desktop and the WebUI run eternal autonomy, /permissions and /plugin.',
  socialDescription:
    'WrongStack 1.5.4: editors install WrongStack over ACP, log in and pick its model from the editor, ACP agents reach files outside the project, and the desktop runs eternal autonomy, /permissions and /plugin.',
  cards: [
    {
      title: 'An ACP agent for any editor',
      body: 'wstack acp no longer exits when no provider is configured. It answers the handshake, offers a terminal login and a settings login, and opens sessions as soon as wstack auth has run, without a restart. Each session carries a model option the editor shows in its model picker.',
      href: '/acp',
      linkLabel: 'Explore ACP',
    },
    {
      title: 'ACP agents reach the files they need',
      body: 'An agent such as Claude Code driven over ACP reads its own settings and temp files through WrongStack. The file server now follows the same allowOutsideProjectRoot policy as WrongStack’s own tools, and writes still pass the permission rules.',
      href: '/acp',
      linkLabel: 'See how ACP works',
    },
    {
      title: 'Eternal autonomy in the desktop',
      body: 'Choosing Eternal in the desktop or the WebUI now runs the loop for that conversation, and /permissions and /plugin run there as in the CLI.',
      href: '/fleet',
      linkLabel: 'See the fleet',
    },
  ],
} as const;
