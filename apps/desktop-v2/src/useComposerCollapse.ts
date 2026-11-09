import { shouldAutoCollapse } from '@wrongstack/project-surfaces/lib/auto-collapse';
import { useEffect, useRef, useState } from 'react';

export function useComposerCollapse({
  sessionId,
  hasMessages,
  enabled,
  running,
  blocked,
}: {
  sessionId: string;
  hasMessages: boolean;
  enabled: boolean;
  running: boolean;
  blocked: boolean;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const previous = useRef({ sessionId: '', hasMessages: false, enabled: false });
  useEffect(() => {
    const before = previous.current;
    if (!enabled || blocked) setCollapsed(false);
    else if (
      !running &&
      shouldAutoCollapse({
        hasMessages,
        autoCollapseInput: enabled,
        sessionChanged: before.sessionId !== sessionId,
        prevHadMessages: before.hasMessages,
        prevAutoCollapse: before.enabled,
      })
    )
      setCollapsed(true);
    previous.current = { sessionId, hasMessages, enabled };
  }, [sessionId, hasMessages, enabled, running, blocked]);
  return { collapsed, expand: () => setCollapsed(false), collapse: () => setCollapsed(true) };
}
