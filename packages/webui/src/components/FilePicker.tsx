import { expectDefined } from '@wrongstack/core/utils/expect-defined';
import { useWebSocket } from '@/hooks/useWebSocket';
import { cn } from '@/lib/utils';
import { getWSClient } from '@/lib/ws-client';
import { useAppTranslation } from '@/i18n';
import { useConfigStore } from '@/stores';
import { FileText, Folder } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
interface FilePickerProps {
  /** Whatever the user typed after the `@` trigger (case-preserved). */
  query: string;
  /** Called when the user picks a file (Enter / Tab / click). */
  onPick: (relPath: string) => void;
  /** Called when the picker should close without inserting (Esc). */
  onClose: () => void;
}

/**
 * `@` file mention popup. Subscribes to the WS `files.list` response,
 * supports ↑/↓ Tab Enter Esc. Refetches on query change with a small
 * debounce so we don't spam the backend on every keystroke.
 */
export function FilePicker({ query, onPick, onClose }: FilePickerProps) {
  const { t } = useAppTranslation();
  const ws = useWebSocket();
  const wsUrl = useConfigStore((s) => s.wsUrl);
  const [files, setFiles] = useState<string[]>([]);
  const [index, setIndex] = useState(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wantHandle = useRef<{ resolve: (paths: string[]) => void } | null>(null);

  // Subscribe to the single `files.list` event for the lifetime of this
  // picker. We use the raw client.on() rather than the hook because the
  // hook installs handlers at boot — but `files.list` is picker-local and
  // the data shouldn't leak into other surfaces.
  useEffect(() => {
    const client = getWSClient(wsUrl);
    const off = client.on('files.list', (msg) => {
      const p = msg.payload as { files: string[] };
      setFiles(p.files ?? []);
      setIndex(0);
      wantHandle.current?.resolve(p.files ?? []);
      wantHandle.current = null;
    });
    return () => off();
  }, [wsUrl]);

  // Debounced fetch on query change.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      ws.client.listFiles(query, 50);
    }, 80);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, ws.client]);

  // Keyboard nav at window level — ChatInput owns the textarea so we
  // intercept keys there and forward intent here via the imperative API.
  // We listen too so click+keyboard mixing works.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setIndex((i) => (i + 1) % Math.max(1, files.length));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setIndex((i) => (i - 1 + Math.max(1, files.length)) % Math.max(1, files.length));
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        if (files.length === 0) return;
        e.preventDefault();
        onPick(expectDefined(files[index]));
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [files, index, onPick, onClose]);

  return (
    <div className="absolute bottom-full left-0 right-0 mb-2 rounded-lg border bg-popover shadow-md p-1 text-sm max-h-72 overflow-auto">
      <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-muted-foreground border-b mb-1 flex items-center justify-between">
        <span>
          {t('activity:filePicker.heading')} {query && `· "${query}"`}
        </span>
        <span>{t('activity:filePicker.selectInsertEscDismiss')}</span>
      </div>
      {files.length === 0 ? (
        <div className="px-3 py-2 text-xs text-muted-foreground italic">
          {query ? t('activity:filePicker.noMatch', { query }) : t('activity:filePicker.searching')}
        </div>
      ) : (
        files.map((p, i) => (
          <button
            key={p}
            type="button"
            onClick={() => onPick(p)}
            onMouseEnter={() => setIndex(i)}
            className={cn(
              'w-full text-left px-3 py-1.5 rounded transition-colors flex items-center gap-2 font-mono text-xs',
              i === index ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/40',
            )}
          >
            {p.includes('/') ? (
              <Folder className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            ) : (
              <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            )}
            <span className="truncate">{p}</span>
          </button>
        ))
      )}
    </div>
  );
}
