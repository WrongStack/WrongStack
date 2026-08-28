import { FileText, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusTrap } from './hooks/use-focus-trap.js';
import { type SocketRequestHandle, socketRequest } from './lib/socket-request.js';
import type { FileEditMeta } from './types.js';
import type { SimpleSocket } from './lib/ws.js';

interface FileDiffPanelProps {
  /** The file edits to show — when multiple, the left list lets you switch. */
  files: FileEditMeta[];
  /** Index of the initial file to display, defaults to 0. */
  initialIndex?: number | undefined;
  /** WebSocket ref for loading file content when diff is unavailable. */
  socketRef?: React.RefObject<SimpleSocket | null> | undefined;
  onClose: () => void;
}

function diffLines(diff: string): { kind: 'add' | 'remove' | 'context' | 'hunk'; text: string }[] {
  const start = diff.indexOf('@@');
  if (start === -1) return [{ kind: 'context', text: diff }];
  const lines: { kind: 'add' | 'remove' | 'context' | 'hunk'; text: string }[] = [];
  for (const line of diff.slice(start).replace(/\r\n/g, '\n').split('\n')) {
    if (line.startsWith('@@')) lines.push({ kind: 'hunk', text: line });
    else if (line.startsWith('+') && !line.startsWith('+++')) lines.push({ kind: 'add', text: line });
    else if (line.startsWith('-') && !line.startsWith('---')) lines.push({ kind: 'remove', text: line });
    else lines.push({ kind: 'context', text: line });
  }
  return lines;
}

export function FileDiffPanel({ files, initialIndex = 0, socketRef, onClose }: FileDiffPanelProps) {
  const [activeIndex, setActiveIndex] = useState(
    () => (files.length === 0 ? 0 : Math.min(initialIndex, files.length - 1)),
  );
  const [loadedContent, setLoadedContent] = useState<string | null>(null);
  const [contentLoading, setContentLoading] = useState(false);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  useFocusTrap(dialogRef, true);
  // Holds the handle of the in-flight content load so a new load (or an
  // unmount) can cancel the previous request's subscription and timeout.
  const pendingLoadRef = useRef<SocketRequestHandle | null>(null);
  const activeFile = files[activeIndex];
  const parsed = activeFile?.diff ? diffLines(activeFile.diff) : [];
  const hasDiff = !!activeFile?.diff;

  // Load file content when the active file has no diff
  const loadContent = useCallback((filePath: string) => {
    if (!socketRef?.current) return;
    // Cancel any in-flight load first: otherwise its stale 8s timeout would
    // later fire setContentLoading(false) and clobber this request's state.
    pendingLoadRef.current?.cancel();
    setContentLoading(true);
    setLoadedContent(null);

    const handle = socketRequest({
      socket: socketRef.current,
      sendType: 'files.read',
      payload: { filePath },
      expectType: 'files.read',
      accept: (frame) => {
        const returned = frame.payload as { filePath?: unknown } | undefined;
        return returned?.filePath === filePath;
      },
    });
    pendingLoadRef.current = handle;
    void handle.promise.then((payload) => {
      if (pendingLoadRef.current !== handle) return;
      pendingLoadRef.current = null;
      setContentLoading(false);
      if (payload && typeof payload['content'] === 'string') {
        setLoadedContent(payload['content']);
      }
    });
  }, [socketRef]);

  // Sync active index when the parent passes a new initialIndex after mount.
  useEffect(() => {
    setActiveIndex(files.length === 0 ? 0 : Math.min(initialIndex, files.length - 1));
  }, [initialIndex, files.length]);

  // Cancel any in-flight load on unmount so its timeout can't fire against a
  // dead component.
  useEffect(() => () => pendingLoadRef.current?.cancel(), []);

  // Reset and load on file change
  useEffect(() => {
    setLoadedContent(null);
    setContentLoading(false);
    if (activeFile && !hasDiff && socketRef?.current) {
      loadContent(activeFile.path);
    }
  }, [activeFile?.path, hasDiff, loadContent, socketRef]);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <>
      <button
        type="button"
        className="diff-overlay"
        aria-label="Close diff panel"
        tabIndex={-1}
        onClick={onClose}
      />
      <aside
        className="diff-panel"
        role="dialog"
        aria-modal="true"
        aria-label="File diff"
        ref={dialogRef}
        tabIndex={-1}
      >
        <header className="diff-head">
          <span>
            <FileText size={13} aria-hidden="true" /> FILE DIFF
          </span>
          <button type="button" onClick={onClose} aria-label="Close diff panel" ref={closeRef}>
            <X size={14} />
          </button>
        </header>
        <div className="diff-body">
          {files.length > 0 && (
            <nav className="diff-file-list" aria-label="Changed files">
              {files.map((file, index) => (
                <button
                  type="button"
                  key={file.path}
                  className={`diff-file-item${activeIndex === index ? ' active' : ''}`}
                  onClick={() => setActiveIndex(index)}
                >
                  <FileText size={12} aria-hidden="true" />
                  <span>{file.path.split(/[\\/]/).pop() ?? file.path}</span>
                  {file.replacements != null && (
                    <b className="diff-stat-green">+{file.replacements}</b>
                  )}
                  {file.created && <span className="diff-stat-green">new</span>}
                </button>
              ))}
            </nav>
          )}
          <div className="diff-view">
            {activeFile ? (
              <>
                <div className="diff-view-head">
                  <div className="diff-view-head-path">
                    <code>{activeFile.path.split(/[\\/]/).pop() ?? activeFile.path}</code>
                    <span className="diff-view-head-full">{activeFile.path}</span>
                  </div>
                  <span>
                    {!hasDiff && !contentLoading && loadedContent && (
                      <span className="diff-stat-muted">current content</span>
                    )}
                    {activeFile.replacements != null && (
                      <b className="diff-stat-green">+{activeFile.replacements}</b>
                    )}
                    {activeFile.bytesWritten != null && (
                      <span className="diff-stat-muted">{activeFile.bytesWritten} bytes</span>
                    )}
                    {activeFile.created && <span className="diff-stat-green">created</span>}
                  </span>
                </div>
                {hasDiff ? (
                  <pre className="diff-view-content">
                    {parsed.map((line, i) => (
                      <span key={i} className={`diff-line diff-line-${line.kind}`}>
                        {line.text}{'\n'}
                      </span>
                    ))}
                  </pre>
                ) : contentLoading ? (
                  <div className="diff-view-empty">Loading file content…</div>
                ) : loadedContent != null ? (
                  <pre className="diff-view-content">{loadedContent}</pre>
                ) : (
                  <div className="diff-view-empty">No diff data available for this file.</div>
                )}
              </>
            ) : (
              <div className="diff-view-empty">Select a file to view its diff.</div>
            )}
          </div>
        </div>
      </aside>
    </>
  );
}
