/** Curated public release copy; the version guard requires a refresh on every release. */
export const releaseHighlights = {
  version: '1.7.5',
  title: 'Files that load, text that keeps its shape.',
  summary:
    'State, profiles, caches and manifests saved with a byte order mark load again, and malformed JSON roots produce controlled errors. Truncation, prompts and editor search keep Unicode boundaries and literal replacement text, numeric options and durations are validated, and Windows recovers from transient Microsoft Store PowerShell launch denials.',
  socialDescription:
    'WrongStack 1.7.5: BOM-tolerant state files, Unicode-safe truncation and search, validated numeric options and steadier Windows PowerShell launches.',
  cards: [
    {
      title: 'Files that load',
      body: 'State, profiles, caches and toolchain manifests saved with a byte order mark are read, and malformed JSON gives a controlled error or fallback.',
      href: '/getting-started',
      linkLabel: 'Upgrade your installation',
    },
    {
      title: 'Text that keeps its shape',
      body: 'Prompts, evidence excerpts, output truncation and editor search respect Unicode boundaries and literal replacement text.',
      href: '/interfaces',
      linkLabel: 'Explore the interfaces',
    },
    {
      title: 'Validated input',
      body: 'Numeric options, durations, telemetry and quota windows are checked, and authorization cancellation stays within its own session.',
      href: '/security',
      linkLabel: 'Explore the safeguards',
    },
  ],
} as const;
