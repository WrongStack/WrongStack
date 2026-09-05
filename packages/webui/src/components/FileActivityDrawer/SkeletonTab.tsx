import { Check, Copy, FileCode, Loader2, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { getWSClient } from '@/lib/ws-client';
import { type OpenFile, useConfigStore, useFileStore } from '@/stores';
import type { WSServerMessage } from '@/types';

export function SkeletonTab({ file }: { file: OpenFile }) {
  const wsUrl = useConfigStore((state) => state.wsUrl);
  const jumpToLine = useFileStore((state) => state.jumpToLine);
  const client = useMemo(() => getWSClient(wsUrl), [wsUrl]);
  const [skeleton, setSkeleton] = useState<string>('');
  const [stats, setStats] = useState<{
    originalLines: number;
    skeletonLines: number;
    tokenSavingsPercent: number;
    symbolCount: number;
  } | null>(null);
  const [lang, setLang] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [collapseImports, setCollapseImports] = useState(false);
  const [includeDocs, setIncludeDocs] = useState(true);

  const fetchSkeleton = useCallback(() => {
    setLoading(true);
    setError(null);
    client.send({
      type: 'files.skeleton',
      payload: {
        filePath: file.path,
        content: file.content,
        options: {
          collapseImports,
          includeDocs,
        },
      },
    });
  }, [client, file.path, file.content, collapseImports, includeDocs]);

  useEffect(() => {
    const off = client.on('files.skeleton_result', (message: WSServerMessage) => {
      if (message.type !== 'files.skeleton_result') return;
      if (message.payload.filePath !== file.path) return;
      setLoading(false);
      if (message.payload.error) {
        setError(message.payload.error);
        return;
      }
      setSkeleton(message.payload.skeleton);
      if (message.payload.stats) setStats(message.payload.stats);
      if (message.payload.lang) setLang(message.payload.lang);
    });

    fetchSkeleton();
    return () => {
      off();
    };
  }, [client, file.path, fetchSkeleton]);

  const handleCopy = async () => {
    if (!skeleton) return;
    try {
      await navigator.clipboard.writeText(skeleton);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  };

  const renderInteractiveLine = (line: string, idx: number) => {
    const match = line.match(/(?:\/\*\s*L(\d+)(?:-L\d+)?\s*\*\/|#\s*L(\d+)(?:-L\d+)?)/);
    const targetLineNum = match ? parseInt(match[1] || match[2] || '0', 10) : null;

    if (targetLineNum && targetLineNum > 0) {
      return (
        <div
          key={idx}
          className="group flex items-center justify-between gap-2 rounded px-1.5 py-0.5 hover:bg-primary/10 transition-colors"
        >
          <span className="truncate">{line}</span>
          <button
            type="button"
            onClick={() => jumpToLine(targetLineNum)}
            className="shrink-0 cursor-pointer rounded bg-primary/20 px-1.5 py-0.5 font-mono text-[9px] font-semibold text-primary opacity-75 group-hover:opacity-100 hover:bg-primary hover:text-primary-foreground transition-all"
            title={`Jump to line ${targetLineNum} in editor`}
          >
            Jump to L{targetLineNum} →
          </button>
        </div>
      );
    }

    return (
      <div key={idx} className="px-1.5 py-0.5 whitespace-pre">
        {line}
      </div>
    );
  };

  return (
    <div className="flex h-full min-h-[140px] flex-col p-2">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 border-b border-border/50 pb-2">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1 rounded bg-primary/10 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase text-primary">
            <FileCode className="h-3 w-3" />
            {lang || 'AST'}
          </span>
          {stats && (
            <>
              <span className="rounded bg-success/10 px-1.5 py-0.5 font-mono text-[10px] font-medium text-success">
                -{stats.tokenSavingsPercent}% Tokens
              </span>
              <span className="text-[10px] text-muted-foreground">
                {stats.originalLines} → {stats.skeletonLines} lines
              </span>
              <span className="text-[10px] text-muted-foreground">
                ({stats.symbolCount} symbols)
              </span>
            </>
          )}
        </div>

        <div className="flex items-center gap-2 text-[10px]">
          <label className="inline-flex cursor-pointer items-center gap-1 text-muted-foreground hover:text-foreground">
            <input
              type="checkbox"
              checked={collapseImports}
              onChange={(e) => setCollapseImports(e.target.checked)}
              className="rounded border-border"
            />
            <span>Collapse imports</span>
          </label>
          <label className="inline-flex cursor-pointer items-center gap-1 text-muted-foreground hover:text-foreground">
            <input
              type="checkbox"
              checked={includeDocs}
              onChange={(e) => setIncludeDocs(e.target.checked)}
              className="rounded border-border"
            />
            <span>Include docs</span>
          </label>
          <button
            type="button"
            onClick={fetchSkeleton}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            title="Refresh Skeleton"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          </button>
          <button
            type="button"
            onClick={handleCopy}
            disabled={!skeleton}
            className="inline-flex items-center gap-1 rounded bg-secondary px-2 py-1 text-[10px] font-medium text-secondary-foreground hover:bg-secondary/80 disabled:opacity-50"
          >
            {copied ? <Check className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3" />}
            <span>{copied ? 'Copied' : 'Copy'}</span>
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto rounded border border-border/60 bg-muted/20 p-2 font-mono text-[11px] leading-relaxed">
        {loading && !skeleton ? (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin text-primary" />
            <span>Extracting AST Skeleton…</span>
          </div>
        ) : error ? (
          <div className="p-4 text-warning">{error}</div>
        ) : (
          <div className="font-mono select-text">
            {skeleton.split('\n').map((line, idx) => renderInteractiveLine(line, idx))}
          </div>
        )}
      </div>
    </div>
  );
}
