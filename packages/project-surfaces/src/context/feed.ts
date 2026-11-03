import { useSurfaceHost } from '../host';
import type { ContextFeed } from './context-host';

/** The host's context feed; the dashboard renders only where an application provides one. */
export function useContextFeed(): ContextFeed {
  const feed = useSurfaceHost().context;
  if (!feed) throw new Error('The context dashboard rendered without a context feed.');
  return feed;
}
