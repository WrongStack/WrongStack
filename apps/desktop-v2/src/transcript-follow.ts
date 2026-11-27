import type {
  KeyboardEvent,
  PointerEvent,
  RefObject,
  TouchEvent,
  UIEvent,
  WheelEvent,
} from 'react';
import { useCallback, useEffect, useRef } from 'react';

/** Batch layout and engine updates together and recheck the reader's intent before scrolling. */
export function useTranscriptEndScroll({
  active,
  welcome,
  waitingForInput,
  messages,
  approvals,
  following,
  pane,
  end,
}: {
  active: boolean;
  welcome: boolean;
  waitingForInput: boolean;
  messages: readonly unknown[];
  approvals: readonly unknown[];
  following: RefObject<boolean>;
  pane: RefObject<HTMLDivElement | null>;
  end: RefObject<HTMLDivElement | null>;
}) {
  const frame = useRef<number | null>(null);
  const canFollow = useRef(false);
  canFollow.current = active && !welcome && !waitingForInput;
  const schedule = useCallback(() => {
    if (!canFollow.current || !following.current || frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      if (canFollow.current && following.current) end.current?.scrollIntoView({ block: 'nearest' });
    });
  }, [end, following]);

  useEffect(() => {
    if (active && welcome) pane.current?.scrollTo({ top: 0 });
    else schedule();
  }, [active, welcome, waitingForInput, messages, approvals, pane, schedule]);
  useEffect(() => {
    const node = pane.current;
    if (!active || !node) return;
    const size = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(schedule);
    size?.observe(node);
    const mutation =
      typeof MutationObserver === 'undefined' ? undefined : new MutationObserver(schedule);
    mutation?.observe(node, { childList: true, subtree: true });
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
      size?.disconnect();
      mutation?.disconnect();
    };
  }, [active, pane, schedule]);
}

/** Virtual-row layout never changes reader intent; only explicit input resumes a paused view. */
export function useTranscriptFollowHandlers(
  following: RefObject<boolean>,
  pause: () => void,
  resume: () => void,
) {
  const resumeUntil = useRef(0);
  const touchY = useRef<number | null>(null);
  const userPause = () => {
    resumeUntil.current = 0;
    pause();
  };
  const towardEnd = () => {
    resumeUntil.current = Date.now() + 500;
  };
  const onScrollbar = (event: PointerEvent<HTMLDivElement>) => {
    const pane = event.currentTarget;
    return (
      event.clientX >=
      pane.getBoundingClientRect().right - Math.max(12, pane.offsetWidth - pane.clientWidth)
    );
  };
  return {
    onScroll(event: UIEvent<HTMLDivElement>) {
      const pane = event.currentTarget;
      const near = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 80;
      if (near && (following.current || Date.now() <= resumeUntil.current)) resume();
    },
    onWheel(event: WheelEvent<HTMLDivElement>) {
      if (event.deltaY < 0) userPause();
      else if (event.deltaY > 0) towardEnd();
    },
    onTouchStart(event: TouchEvent<HTMLDivElement>) {
      touchY.current = event.touches[0]?.clientY ?? null;
    },
    onTouchMove(event: TouchEvent<HTMLDivElement>) {
      const next = event.touches[0]?.clientY ?? null,
        previous = touchY.current;
      if (next !== null && previous !== null) {
        if (next > previous) userPause();
        else if (next < previous) towardEnd();
      }
      touchY.current = next;
    },
    onPointerDown(event: PointerEvent<HTMLDivElement>) {
      if (onScrollbar(event)) {
        pause();
        towardEnd();
      }
    },
    onPointerMove(event: PointerEvent<HTMLDivElement>) {
      if (event.buttons === 1 && onScrollbar(event)) towardEnd();
    },
    onKeyDownCapture(event: KeyboardEvent<HTMLDivElement>) {
      const target = event.target as HTMLElement;
      if (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
        return;
      if (
        ['ArrowUp', 'PageUp', 'Home'].includes(event.key) ||
        (event.key === ' ' && event.shiftKey)
      )
        userPause();
      else if (['ArrowDown', 'PageDown', 'End'].includes(event.key) || event.key === ' ')
        towardEnd();
    },
  };
}
