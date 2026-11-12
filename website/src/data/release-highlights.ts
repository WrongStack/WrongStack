/** Curated public release copy; the version guard requires a refresh on every release. */
export const releaseHighlights = {
  version: '1.6.0',
  title: 'Branch your conversation, and a terminal UI that keeps up.',
  summary:
    '/tree forks, switches and folds branches inside one session, each with its own workspace snapshot; plugins draw panels, the terminal previews images, and the desktop app runs Design Studio. A typed character now echoes in about 15 ms instead of over 100 ms, a streaming answer paints twice as often at the same CPU, and a frame writes a fraction of the bytes it did. The secret scanner also stops mistaking grep -n output for a Telegram bot token.',
  socialDescription:
    'WrongStack 1.6.0: branch a conversation with /tree, plugin panels and inline images in the terminal, Context X-Ray, Design Studio on the desktop, and a terminal UI that echoes keystrokes in ~15 ms.',
  cards: [
    {
      title: 'Keystrokes echo at once',
      body: 'The stream no longer re-renders the whole terminal app on every flush: only the parts that show it redraw. With a higher frame ceiling, key echo fell from 115 ms to 16 ms idle and from 134 ms to 33 ms while an answer streams.',
      href: '/getting-started',
      linkLabel: 'Install WrongStack',
    },
    {
      title: 'Less work in every frame',
      body: 'Ink’s tokenization caches now live across frames, so the sidebar, status bar and visible history are not tokenized again on each repaint. The same streaming workload uses about a quarter less CPU.',
      href: '/getting-started',
      linkLabel: 'Try the terminal UI',
    },
    {
      title: 'Branch a conversation with /tree',
      body: 'Fork a branch from the head or an earlier prompt, switch between branches with their own workspace snapshots, and fold one back as a short, secret-scrubbed summary — all inside one session.',
      href: '/getting-started',
      linkLabel: 'Get started',
    },
  ],
} as const;
