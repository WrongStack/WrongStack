import type {
  KeyboardEvent,
  PointerEvent,
  RefObject,
  TouchEvent,
  UIEvent,
  WheelEvent,
} from 'react';
import { useRef } from 'react';

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
