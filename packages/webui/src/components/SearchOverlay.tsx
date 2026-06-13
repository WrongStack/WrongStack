import { cn } from '@/lib/utils';
import { useChatStore, useUIStore } from '@/stores';
import { ArrowDown, ArrowUp, Search, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

/**
 * Ctrl+F overlay that searches the current chat transcript. Hits are
 * counted as the user types; ↑/↓ step between hits and Enter scrolls the
 * highlighted message into view. The actual highlight is handed off via a
 * DOM data attribute so we don't need to invasively rewrap message
 * rendering — see ChatView for where the active hit gets the highlight
 * class applied.
 */
export function SearchOverlay() {
  const open = useUIStore((s) => s.searchOpen);
  const setOpen = useUIStore((s) => s.setSearchOpen);
  const query = useUIStore((s) => s.searchQuery);
  const setQuery = useUIStore((s) => s.setSearchQuery);
  const messages = useChatStore((s) => s.messages);

  const requestScrollToMessage = useUIStore((s) => s.requestScrollToMessage);
  const inputRef = useRef<HTMLInputElement>(null);
  const [activeHit, setActiveHit] = useState(0);
  // Bumped over a few frames after a navigation so the highlight pass re-runs
  // once the (virtualized-out) active hit has been scrolled in and mounted.
  const [repaintNonce, setRepaintNonce] = useState(0);

  useEffect(() => {
    if (open) requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  const hits = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [] as string[];
    return messages
      .filter((m) => {
        if (m.role === 'tool') {
          return (
            (m.toolName ?? '').toLowerCase().includes(q) ||
            (m.toolResult ?? '').toLowerCase().includes(q) ||
            JSON.stringify(m.toolInput ?? '')
              .toLowerCase()
              .includes(q)
          );
        }
        return m.content.toLowerCase().includes(q);
      })
      .map((m) => m.id);
  }, [messages, query]);

  useEffect(() => {
    if (activeHit >= hits.length) setActiveHit(0);
  }, [hits, activeHit]);

  // Paint every match of the current query inside chat bubbles using the
  // CSS Custom Highlights API. We walk the text nodes under every
  // `[data-message-id]` element, build Range objects per hit, then register
  // two highlights: `chat-search` covers everything, `chat-search-active`
  // covers only the message currently navigated to (so the user can see
  // where they are in the list). The registry is cleared on unmount and on
  // every query change so stale ranges don't linger.
  // biome-ignore lint/correctness/useExhaustiveDependencies: repaintNonce re-runs the pass after a virtualized hit mounts
  useEffect(() => {
    // Feature-detect — falls back to silent no-op on older browsers; the
    // ring-flash navigation behaviour below still works.
    const win = window as unknown as {
      CSS?: { highlights?: Map<string, unknown> };
      Highlight?: new (...ranges: Range[]) => unknown | undefined;
    };
    const highlights = win.CSS?.highlights;
    const HighlightCtor = win.Highlight;
    if (!highlights || !HighlightCtor) return;
    const clear = () => {
      highlights.delete('chat-search');
      highlights.delete('chat-search-active');
    };
    const q = query.trim();
    if (!q || !open) {
      clear();
      return;
    }
    const lcQuery = q.toLowerCase();
    const allRanges: Range[] = [];
    const activeRanges: Range[] = [];
    const activeId = hits[activeHit];
    for (const el of document.querySelectorAll('[data-message-id]')) {
      const id = (el as HTMLElement).dataset.messageId;
      const isActive = id === activeId;
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode() as Text | null;
      while (node) {
        const text = node.nodeValue ?? '';
        if (text.length > 0) {
          const lc = text.toLowerCase();
          let from = 0;
          while (from <= lc.length - lcQuery.length) {
            const at = lc.indexOf(lcQuery, from);
            if (at === -1) break;
            const range = document.createRange();
            range.setStart(node, at);
            range.setEnd(node, at + lcQuery.length);
            allRanges.push(range);
            if (isActive) activeRanges.push(range);
            from = at + lcQuery.length;
          }
        }
        node = walker.nextNode() as Text | null;
      }
    }
    if (allRanges.length > 0) {
      highlights.set('chat-search', new HighlightCtor(...allRanges) as never);
    } else {
      highlights.delete('chat-search');
    }
    if (activeRanges.length > 0) {
      highlights.set('chat-search-active', new HighlightCtor(...activeRanges) as never);
    } else {
      highlights.delete('chat-search-active');
    }
    return clear;
  }, [query, hits, activeHit, open, repaintNonce]);

  useEffect(() => {
    const id = hits[activeHit];
    if (!id) return;
    // The chat list is virtualized, so the hit may have no DOM node yet — ask
    // ChatView to scroll its VList to that row, then repaint highlights over
    // the next few frames once the element has mounted.
    requestScrollToMessage(id);
    let n = 0;
    let raf = requestAnimationFrame(function tick() {
      setRepaintNonce((v) => v + 1);
      if (++n < 3) raf = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(raf);
  }, [hits, activeHit, requestScrollToMessage]);

  if (!open) return null;

  const step = (dir: 1 | -1) => {
    if (hits.length === 0) return;
    setActiveHit((i) => (i + dir + hits.length) % hits.length);
  };

  return (
    <div className="absolute top-2 right-4 z-30 w-[28rem] max-w-[calc(100%-2rem)] rounded-lg border bg-popover shadow-xl">
      <div className="flex items-center gap-2 px-3 py-2">
        <Search className="h-4 w-4 text-muted-foreground shrink-0" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              setOpen(false);
            } else if (e.key === 'Enter') {
              e.preventDefault();
              step(e.shiftKey ? -1 : 1);
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              step(1);
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              step(-1);
            }
          }}
          placeholder="Search in chat…"
          className="flex-1 bg-transparent outline-none text-sm placeholder:text-muted-foreground"
        />
        <span className="text-xs text-muted-foreground tabular-nums shrink-0">
          {hits.length === 0 ? (query ? '0' : '') : `${activeHit + 1} / ${hits.length}`}
        </span>
        <button
          type="button"
          onClick={() => step(-1)}
          disabled={hits.length === 0}
          className={cn(
            'p-1 rounded hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed',
          )}
          title="Previous hit"
        >
          <ArrowUp className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => step(1)}
          disabled={hits.length === 0}
          className={cn(
            'p-1 rounded hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed',
          )}
          title="Next hit"
        >
          <ArrowDown className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="p-1 rounded hover:bg-muted text-muted-foreground"
          title="Close (Esc)"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
