/** Curated public release copy; the version guard requires a refresh on every release. */
export const releaseHighlights = {
  version: '1.5.5',
  title: 'ACP permissions follow the file you actually open.',
  summary:
    'ACP reads and writes outside the project are checked against their resolved target, including files reached through links inside the project. Ordinary edits inside a linked project keep their original path, and the macOS installer build reads signed engine entitlements before parsing them.',
  socialDescription:
    'WrongStack 1.5.5: ACP file permissions follow the real target, edits inside linked projects keep their original path, and the macOS installer check reads signed engine entitlements correctly.',
  cards: [
    {
      title: 'Permission checks follow the target',
      body: 'When an ACP file request leaves the project, WrongStack checks the resolved target against its permission rules and then opens that same path. A link inside the project cannot hide an outside write to agent state.',
      href: '/acp',
      linkLabel: 'Explore ACP',
    },
    {
      title: 'Linked projects keep ordinary edits local',
      body: 'An in-project ACP write keeps the path the agent supplied. A symlinked project root on macOS or a Windows short path no longer turns an ordinary edit into an outside-project permission request.',
      href: '/acp',
      linkLabel: 'See file access rules',
    },
    {
      title: 'macOS installer checks read the full plist',
      body: 'The release build reads the signed entitlement bytes before parsing them, avoiding a seek on a pipe. It still requires the bundled engine’s allow-jit entitlement and a successful engine boot.',
      href: '/getting-started',
      linkLabel: 'Install WrongStack',
    },
  ],
} as const;
