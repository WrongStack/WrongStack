import { Brain, FileText, Hash, Link2, Search, Tag, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useFocusTrap } from './hooks/use-focus-trap.js';
import { onSimplePanel } from './lib/panel-events.js';
import { type SocketRequestHandle, socketRequest } from './lib/socket-request.js';
import type { SimpleSocket } from './lib/ws.js';

interface MemoryEntry {
  id: string;
  text: string;
  kind: string;
  tags?: string[];
  anchors?: { type: string; path?: string; symbol?: string }[];
}

interface MemoryDrawerProps {
  socketRef: React.RefObject<SimpleSocket | null>;
}

export function MemoryDrawer({ socketRef }: MemoryDrawerProps) {
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState('');
  const [results, setResults] = useState<MemoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  useFocusTrap(dialogRef, open);
  const pendingSearchRef = useRef<SocketRequestHandle | null>(null);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => {
    const onOpen = () => setOpen(true);
    return onSimplePanel('open-memory-drawer', onOpen);
  }, []);

  // Cancel a pending search on unmount (prevents setState on unmounted component)
  useEffect(() => {
    return () => pendingSearchRef.current?.cancel();
  }, []);

  const search = () => {
    if (!path.trim()) return;
    setLoading(true);
    setError(null);
    const socket = socketRef.current;
    if (!socket) {
      setLoading(false);
      return;
    }

    pendingSearchRef.current?.cancel();
    const handle = socketRequest({
      socket,
      sendType: 'memory.sage.forFile',
      // The request field is `filePath` — sending `path` made the server
      // reject every search with "filePath is required".
      payload: { filePath: path.trim(), limit: 20 },
      expectType: 'memory.sage.forFile',
      timeoutMs: 5000,
    });
    pendingSearchRef.current = handle;
    void handle.promise.then((envelope) => {
      if (pendingSearchRef.current !== handle) return;
      pendingSearchRef.current = null;
      setLoading(false);
      if (!envelope) {
        setError('Memory search timed out.');
        setResults([]);
        return;
      }
      if (envelope['error']) {
        setError(String(envelope['error']));
        setResults([]);
        return;
      }
      // Server sends three buckets (primaryMatches / symbolMatches / relatedMatches),
      // each containing MemoryForFileMatch objects with a nested `memory` property,
      // under `payload.response`.
      const payload = envelope['response'] as Record<string, unknown> | undefined;
      const primary = Array.isArray(payload?.['primaryMatches'])
        ? (payload!['primaryMatches'] as Record<string, unknown>[])
        : [];
      const symbol = Array.isArray(payload?.['symbolMatches'])
        ? (payload!['symbolMatches'] as Record<string, unknown>[])
        : [];
      const related = Array.isArray(payload?.['relatedMatches'])
        ? (payload!['relatedMatches'] as Record<string, unknown>[])
        : [];
      const matches = [...primary, ...symbol, ...related];
      const rawMemories = matches.map(
        (m) => (m['memory'] as Record<string, unknown> | undefined) ?? m,
      ) as unknown as MemoryEntry[];
      const uniqueMemories = Array.from(
        new Map(rawMemories.filter((m) => m?.id).map((m) => [m.id, m])).values(),
      );
      setResults(uniqueMemories);
    });
  };

  if (!open) {
    return (
      <button
        type="button"
        className="memory-drawer-trigger"
        aria-label="Open memory drawer"
        title="Search project memory"
        onClick={() => setOpen(true)}
      >
        <Brain size={13} aria-hidden="true" />
      </button>
    );
  }

  return (
    <>
      <button
        type="button"
        className="settings-overlay"
        tabIndex={-1}
        onClick={() => setOpen(false)}
      />
      <aside
        className="memory-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Memory search"
        ref={dialogRef}
        tabIndex={-1}
      >
        <header className="memory-drawer-head">
          <span>
            <Brain size={13} aria-hidden="true" /> MEMORY
          </span>
          <button type="button" onClick={() => setOpen(false)} aria-label="Close" ref={closeRef}>
            <X size={14} />
          </button>
        </header>
        <div className="memory-drawer-search">
          <Search size={13} aria-hidden="true" />
          <input
            type="text"
            placeholder="File path to search memories for…"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') search();
            }}
          />
          <button type="button" onClick={search} disabled={loading || !path.trim()}>
            {loading ? '…' : 'Search'}
          </button>
        </div>
        <div className="memory-drawer-results">
          {error && <p className="memory-drawer-error">{error}</p>}
          {results.length === 0 && !loading && !error && (
            <p className="memory-drawer-empty">
              {path ? 'No memories found for this path.' : 'Enter a file path to search.'}
            </p>
          )}
          {results.map((mem) => (
            <article key={mem.id} className="memory-card">
              <div className="memory-card-head">
                <span className={`memory-kind memory-kind-${mem.kind}`}>{mem.kind}</span>
                {mem.tags && mem.tags.length > 0 && (
                  <span className="memory-card-tags">
                    <Tag size={10} aria-hidden="true" />
                    {mem.tags.slice(0, 3).join(', ')}
                    {mem.tags.length > 3 && ` +${mem.tags.length - 3}`}
                  </span>
                )}
              </div>
              <p className="memory-card-text">{mem.text}</p>
              {mem.anchors && mem.anchors.length > 0 && (
                <div className="memory-card-anchors">
                  {mem.anchors.slice(0, 3).map((a, i) => (
                    <span key={i} className="memory-anchor">
                      {a.type === 'file' ? (
                        <FileText size={10} aria-hidden="true" />
                      ) : a.type === 'symbol' ? (
                        <Hash size={10} aria-hidden="true" />
                      ) : (
                        <Link2 size={10} aria-hidden="true" />
                      )}
                      {a.symbol ?? a.path ?? a.type}
                    </span>
                  ))}
                </div>
              )}
            </article>
          ))}
        </div>
      </aside>
    </>
  );
}
