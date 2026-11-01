'use client';

/**
 * A read-only look at one conversation without leaving the fleet view.
 *
 * Same transcript pipeline as the Console. It is a peek, not a modal: the
 * fleet stays usable behind it, Escape closes it, focus moves in on open and
 * returns on close. Talking back happens in the Console, one click away.
 */
import { TranscriptExpansionProvider } from '@hq/components/hq/transcript/expansion';
import { useHqStore } from '@hq/data/store/index';
import type { FleetTopologyNode } from '@hq/domain/fleet-topology-types';
import { turnKey, useSessionTranscript } from '@hq/domain/use-session-transcript';
import { ArrowDown, ExternalLink, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { useEffect, useId, useMemo, useRef } from 'react';
import { VList } from 'virtua';
import { agentNameMap } from '@/features/transcript/model';
import { TranscriptTurn } from '@/features/transcript/turn';
import { consoleHref } from './model';

export function PeekPanel({
  node,
  onClose,
}: {
  node: FleetTopologyNode;
  onClose: () => void;
}): ReactNode {
  const router = useRouter();
  const sessionId = node.sessionId ?? null;
  const agentId = node.agentId ?? null;
  const chat = useSessionTranscript(sessionId, agentId);
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const href = consoleHref(node);
  const agentNames = useMemo(() => agentNameMap(node.session?.agents), [node.session?.agents]);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    closeRef.current?.focus({ preventScroll: true });
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      if (previous?.isConnected === true) previous.focus({ preventScroll: true });
    };
  }, [onClose]);

  const openConsole = (): void => {
    if (href === null || sessionId === null) return;
    const store = useHqStore.getState();
    if (agentId === null) store.selectSession(sessionId);
    else store.selectAgent(sessionId, agentId);
    router.push(href);
  };

  const session = node.session;
  return (
    <aside
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      className="absolute inset-y-0 right-0 z-20 flex w-[min(560px,100%)] flex-col border-l border-border bg-card shadow-2xl"
    >
      <header className="flex items-start gap-3 border-b border-border px-5 py-4">
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="truncate font-display text-lg font-semibold">
            {node.label}
          </h2>
          <p className="truncate text-sm text-muted-foreground">
            {session !== undefined
              ? `${session.projectName} · ${session.hostname ?? session.machineId} · ${session.clientKind.toUpperCase()}`
              : (node.sub ?? '')}
          </p>
        </div>
        {href !== null && (
          <button
            type="button"
            onClick={openConsole}
            className="inline-flex h-9 shrink-0 items-center gap-2 bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            <ExternalLink className="size-4" />
            Open in Console
          </button>
        )}
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          aria-label="Close preview"
          className="grid size-9 shrink-0 place-items-center text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </header>

      <div className="relative min-h-0 flex-1">
        {chat.loading && chat.entries.length === 0 ? (
          <p className="p-5 text-sm text-muted-foreground">Loading transcript…</p>
        ) : chat.error !== null ? (
          <p className="p-5 text-sm text-destructive">{chat.error}</p>
        ) : chat.entries.length === 0 ? (
          <p className="p-5 text-sm text-muted-foreground">Nothing has been said here yet.</p>
        ) : (
          <TranscriptExpansionProvider>
            <VList
              ref={chat.listRef}
              onScroll={chat.onScroll}
              className="hq-transcript h-full px-5 py-3"
            >
              {chat.entries.map((entry, index) => (
                <TranscriptTurn
                  key={turnKey(entry, index)}
                  entry={entry}
                  running={chat.isRunningAt(entry, index)}
                  turnKey={turnKey(entry, index)}
                  agentNames={agentNames}
                />
              ))}
            </VList>
          </TranscriptExpansionProvider>
        )}
        {!chat.pinned && chat.entries.length > 0 && (
          <button
            type="button"
            onClick={chat.jumpToLatest}
            className="absolute bottom-4 right-5 inline-flex h-9 items-center gap-2 bg-foreground px-3 text-sm text-background shadow-lg"
          >
            <ArrowDown className="size-4" />
            Latest
          </button>
        )}
      </div>
    </aside>
  );
}
