/** Curated public release copy; the version guard requires a refresh on every release. */
export const releaseHighlights = {
  version: '1.6.2',
  title: 'A desktop app that doesn’t keep you waiting.',
  summary:
    'Conversations open and resume on an engine that has already booted, settings and the last project start while the window comes up, and stopping a conversation closes its journals instead of killing the engine. Chronicle opens without reading its whole journal, and the desktop screens move closer to the WebUI.',
  socialDescription:
    'WrongStack 1.6.2: desktop conversations open on an already-booted engine, settings and the last project start at launch, stopping a conversation closes its journals, and Chronicle opens without reading its whole journal.',
  cards: [
    {
      title: 'An engine already waiting',
      body: 'After a conversation opens, the desktop boots one spare engine for its working directory; the next new, resumed or forked conversation there takes it instead of a whole boot.',
      href: '/getting-started',
      linkLabel: 'Try the desktop app',
    },
    {
      title: 'Stops that finish their journals',
      body: 'Stopping a conversation asks its engine to shut down, so every journal is ended and nothing looks crashed on the next launch.',
      href: '/getting-started',
      linkLabel: 'Get started',
    },
    {
      title: 'Chronicle at once',
      body: 'The unfiltered view reads only its page through the index instead of decoding every event in the journal.',
      href: '/getting-started',
      linkLabel: 'Install WrongStack',
    },
  ],
} as const;
