/** Curated public release copy; the version guard requires a refresh on every release. */
export const releaseHighlights = {
  version: '1.7.7',
  title: 'Only the engines you open.',
  summary:
    'The desktop starts only the engines a restored workspace or settings need, and provider discovery reuses a fresh cache for the current account instead of discovering on every runtime start. Command redaction covers empty colon values and single-quoted PowerShell values, token checks avoid object conversion hooks, and piped stdin reports truncation exactly at its cap.',
  socialDescription:
    'WrongStack 1.7.7: a desktop that starts only the engines you open, cached provider discovery, and tighter redaction, token checks and input limits.',
  cards: [
    {
      title: 'A lighter launch',
      body: "Only a restored workspace's project services start; Mission Control, the project list and activity start no engines.",
      href: '/interfaces',
      linkLabel: 'Explore the interfaces',
    },
    {
      title: 'Discovery that waits less',
      body: 'A fresh provider discovery cache for the current account is reused for up to five minutes instead of on every start.',
      href: '/getting-started',
      linkLabel: 'Upgrade your installation',
    },
    {
      title: 'Tighter redaction',
      body: 'Empty colon values and single-quoted PowerShell values are redacted, and token checks avoid object conversion hooks.',
      href: '/security',
      linkLabel: 'Explore the safeguards',
    },
  ],
} as const;
