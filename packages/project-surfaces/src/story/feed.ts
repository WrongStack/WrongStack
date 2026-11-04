import { useSurfaceHost } from '../host';
import type { StoryFeed } from './story-host';

/** The host's Session Story feed; the story renders only where an application provides one. */
export function useStoryFeed(): StoryFeed {
  const feed = useSurfaceHost().story;
  if (!feed) throw new Error('The Session Story rendered without a story feed.');
  return feed;
}
