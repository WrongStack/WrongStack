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

export interface TranscriptHandle {
  scrollToMessage(index: number): void;
}

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
  const [focused, setFocused] = useState<number | null>(null);
  const [target, setTarget] = useState<number | null>(null);
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
      scrollToMessage(index) {
        if (index >= 0 && index < messages.length) {
          setTarget(index + 1);
          list.current?.scrollToIndex(index + 1, { align: 'center' });
        }
      },
    }),
    [messages.length],
  );
  // Restore/find can land in an unmeasured row next to a very tall answer. Keep that one
  // row mounted, then navigate again after its real content has committed.
  useLayoutEffect(() => {
    if (target !== null && target < items.length)
      list.current?.scrollToIndex(target, { align: 'center' });
  }, [target, items.length]);
  const kept = [0, items.length - 1];
  if (focused !== null && focused < items.length) kept.push(focused);
  if (target !== null && target < items.length && !kept.includes(target)) kept.push(target);
  return (
    <Virtualizer
      ref={list}
      scrollRef={scrollRef}
      data={items}
      keepMounted={kept}
      onResize={() => {
        if (following?.current) list.current?.scrollToIndex(items.length - 1, { align: 'end' });
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
