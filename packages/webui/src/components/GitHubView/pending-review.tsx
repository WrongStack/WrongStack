import type { GitHubReviewDraftComment } from '@wrongstack/webui-protocol';
import { createContext, type ReactNode, useContext, useMemo, useState } from 'react';

/**
 * Line comments held back to go out together as one review. The state lives
 * with the open pull request's detail pane, so it ends when another item is
 * picked; nothing reaches GitHub until a review action sends it.
 */
export interface PendingReview {
  comments: GitHubReviewDraftComment[];
  add: (comment: GitHubReviewDraftComment) => void;
  remove: (index: number) => void;
  clear: () => void;
}

const PendingReviewContext = createContext<PendingReview | null>(null);

export function PendingReviewProvider({ children }: { children: ReactNode }) {
  const [comments, setComments] = useState<GitHubReviewDraftComment[]>([]);
  const value = useMemo<PendingReview>(
    () => ({
      comments,
      add: (comment) => setComments((list) => [...list, comment]),
      remove: (index) => setComments((list) => list.filter((_, at) => at !== index)),
      clear: () => setComments([]),
    }),
    [comments],
  );
  return <PendingReviewContext.Provider value={value}>{children}</PendingReviewContext.Provider>;
}

/** null outside a pull request's detail pane. */
export function usePendingReview(): PendingReview | null {
  return useContext(PendingReviewContext);
}
