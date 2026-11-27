import {
  type ReactNode,
  type Ref,
  type RefObject,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Virtualizer, type VirtualizerHandle } from 'virtua';
import type { ChatMessage } from './engine-state';
import type { TranscriptHandle } from './transcript-reading-position';

export type { TranscriptHandle } from './transcript-reading-position';

/** Only viewport rows mount; questions and approvals in the footer always remain available. */
export function TranscriptVirtualizer({
  messages,
  renderMessage,
  header,
  footer,
  scrollRef,
  following,
  ref,
}: {
  messages: readonly ChatMessage[];
  renderMessage: (message: ChatMessage, index: number) => ReactNode;
  header: ReactNode;
  footer: ReactNode;
  scrollRef: RefObject<HTMLDivElement | null>;
  following?: RefObject<boolean> | undefined;
  ref?: Ref<TranscriptHandle>;
}) {
  const list = useRef<VirtualizerHandle>(null);
  const liveMessages = useRef(messages);
  liveMessages.current = messages;
  const liveFollowing = useRef(following);
  liveFollowing.current = following;
  const followFrame = useRef<number | null>(null);
  useLayoutEffect(
    () => () => {
      if (followFrame.current !== null) cancelAnimationFrame(followFrame.current);
      followFrame.current = null;
    },
    [],
  );
  const [focused, setFocused] = useState<number | null>(null);
  const [target, setTarget] = useState<{ index: number; offset: number } | null>(null);
  const items = useMemo(
    () => [
      { id: 'header', message: null },
      ...messages.map((message) => ({ id: message.id, message })),
      { id: 'footer', message: null },
    ],
    [messages],
  );
  useImperativeHandle(
    ref,
    () => ({
      scrollToMessage(index, offset = 0) {
        if (index >= 0 && index < liveMessages.current.length) {
          setTarget({ index: index + 1, offset });
          list.current?.scrollToIndex(index + 1, { align: 'start', offset });
        }
      },
      readingPosition() {
        const current = list.current;
        const view = scrollRef.current;
        const messages = liveMessages.current;
        if (!current || !view || !messages.length) return;
        const scrollTop = view.scrollTop;
        const index = Math.max(1, Math.min(messages.length, current.findItemIndex(scrollTop)));
        return {
          messageId: messages[index - 1]!.id,
          offset: Math.round(scrollTop - current.getItemOffset(index)),
        };
      },
    }),
    [scrollRef],
  );
  // Restore/find can land in an unmeasured row next to a very tall answer. Keep that one
  // row mounted, then navigate again after its real content has committed. Later messages
  // must not repeat an earlier navigation, especially while the transcript is hidden.
  // The message starts the row; centering a tall expanded activity can put it above the pane.
  useLayoutEffect(() => {
    if (target)
      list.current?.scrollToIndex(target.index, { align: 'start', offset: target.offset });
  }, [target]);
  const kept = [0, items.length - 1];
  // An empty replay can measure both sentinel rows at zero. Keep the newest answer
  // measurable while following so the first message cannot fall outside that empty range.
  if (messages.length && following?.current) kept.push(items.length - 2);
  if (focused !== null && focused < items.length) kept.push(focused);
  if (target && target.index < items.length && !kept.includes(target.index))
    kept.push(target.index);
  return (
    <Virtualizer
      ref={list}
      scrollRef={scrollRef}
      data={items}
      keepMounted={kept}
      onResize={() => {
        if (!liveFollowing.current?.current || followFrame.current !== null) return;
        // An imperative index scroll keeps retrying through later measurements, even after
        // the reader pauses. A single post-layout jump rechecks the current reader intent.
        followFrame.current = requestAnimationFrame(() => {
          followFrame.current = null;
          const pane = scrollRef.current;
          if (liveFollowing.current?.current && pane) pane.scrollTop = pane.scrollHeight;
        });
      }}
    >
      {(item, index) => (
        <div
          key={item.id}
          className="transcript-row"
          onFocusCapture={() => setFocused(index)}
          onBlurCapture={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(null);
          }}
        >
          {index === 0 ? header : item.message ? renderMessage(item.message, index - 1) : footer}
        </div>
      )}
    </Virtualizer>
  );
}
