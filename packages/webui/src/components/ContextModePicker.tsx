import { expectDefined } from '@wrongstack/core';
import { useWebSocket } from '@/hooks/useWebSocket';
import { cn } from '@/lib/utils';
import { useAppTranslation } from '@/i18n';
import { useSessionStore } from '@/stores';
import { Check, ChevronDown, Gauge, Wrench, Zap, FileSearch } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

export function ContextModePicker() {
  const { t } = useAppTranslation();
  const contextMode = useSessionStore((s) => s.contextMode);
  const contextModes = useSessionStore((s) => s.contextModes);
  const { listContextModes, switchContextMode, client } = useWebSocket();
  const [open, setOpen] = useState(false);
  const [opsOpen, setOpsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const opsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) listContextModes();
  }, [open, listContextModes]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Dismiss ops menu when clicking outside
  useEffect(() => {
    if (!opsOpen) return;
    const onClick = (e: MouseEvent) => {
      if (!opsRef.current?.contains(e.target as Node)) setOpsOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [opsOpen]);

  const compact = useCallback((aggressive: boolean) => {
    client?.compactContext?.(aggressive);
    setOpsOpen(false);
    setOpen(false);
  }, [client]);

  const repair = useCallback(() => {
    client?.repairContext?.();
    setOpsOpen(false);
    setOpen(false);
  }, [client]);

  const items = contextModes.length > 0
    ? contextModes
    : [
        {
          id: 'balanced',
          name: t('activity:ctxMode.fallbackName'),
          description: t('activity:ctxMode.fallbackDesc'),
          thresholds: { warn: 0.6, soft: 0.75, hard: 0.9 },
          preserveK: 10,
          eliseThreshold: 2000,
        },
      ];
  const active = items.find((m) => m.id === contextMode) ?? expectDefined(items[0]);

  return (
    <div ref={rootRef} className="relative shrink-0">
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className={cn(
            'flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium',
            'bg-success/10 text-success hover:bg-success/15 transition-colors border border-transparent hover:border-success/30',
          )}
          title={t('activity:ctxMode.triggerTitle')}
        >
          <Gauge className="h-3 w-3" />
          {t('activity:ctxMode.ctxPrefix')} <span className="font-mono">{contextMode || active.id}</span>
          <ChevronDown className="h-3 w-3 opacity-60" />
        </button>

        {/* Context operations — wrench dropdown */}
        <div ref={opsRef} className="relative">
          <button
            type="button"
            onClick={() => setOpsOpen((v) => !v)}
            className={cn(
              'flex items-center justify-center h-5 w-5 rounded-full',
              'text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors',
              opsOpen && 'bg-accent/50 text-foreground',
            )}
            title={t('activity:ctxMode.opsHeading')}
          >
            <Wrench className="h-3 w-3" />
          </button>
          {opsOpen && (
            <div className="absolute top-full right-0 mt-1 w-52 rounded-md border bg-popover shadow-lg z-40 py-1">
              <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground border-b">
                {t('activity:ctxMode.opsHeading')}
              </div>
              <button
                type="button"
                onClick={() => compact(false)}
                className="w-full text-left px-3 py-2 hover:bg-accent/40 flex items-center gap-2"
              >
                <Zap className="h-3.5 w-3.5 shrink-0 text-warning" />
                <div>
                  <div className="text-xs">{t('activity:ctxMode.compactNow')}</div>
                  <div className="text-[10px] text-muted-foreground">{t('activity:ctxMode.compactNowDesc')}</div>
                </div>
              </button>
              <button
                type="button"
                onClick={() => compact(true)}
                className="w-full text-left px-3 py-2 hover:bg-accent/40 flex items-center gap-2"
              >
                <Zap className="h-3.5 w-3.5 shrink-0 text-destructive" />
                <div>
                  <div className="text-xs">{t('activity:ctxMode.compactAggressive')}</div>
                  <div className="text-[10px] text-muted-foreground">{t('activity:ctxMode.compactAggressiveDesc')}</div>
                </div>
              </button>
              <button
                type="button"
                onClick={repair}
                className="w-full text-left px-3 py-2 hover:bg-accent/40 flex items-center gap-2"
              >
                <Wrench className="h-3.5 w-3.5 shrink-0 text-info" />
                <div>
                  <div className="text-xs">{t('activity:ctxMode.repairContext')}</div>
                  <div className="text-[10px] text-muted-foreground">{t('activity:ctxMode.repairDesc')}</div>
                </div>
              </button>
              <div className="border-t mt-1 pt-1 px-3 py-1.5">
                <button
                  type="button"
                  onClick={() => {
                    // Trigger the context debug (breakdown modal) via a custom event.
                    // ChatView listens for this and opens the modal.
                    document.dispatchEvent(new CustomEvent('open:context-breakdown'));
                    setOpsOpen(false);
                    setOpen(false);
                  }}
                  className="w-full text-left px-3 py-2 hover:bg-accent/40 flex items-center gap-2"
                >
                  <FileSearch className="h-3.5 w-3.5 shrink-0 text-success" />
                  <div>
                    <div className="text-xs">{t('activity:ctxMode.debugContext')}</div>
                    <div className="text-[10px] text-muted-foreground">{t('activity:ctxMode.debugDesc')}</div>
                  </div>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {open && (
        <div className="absolute top-full left-0 mt-1 w-80 rounded-md border bg-popover shadow-lg z-30 py-1">
          <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground border-b">
            {t('activity:ctxMode.windowHeading')}
          </div>
          {items.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => {
                switchContextMode(m.id);
                setOpen(false);
              }}
              className={cn(
                'w-full text-left px-3 py-2 hover:bg-accent/40 flex items-start gap-2',
                m.id === contextMode && 'bg-accent/30',
              )}
            >
              <Check
                className={cn(
                  'h-3.5 w-3.5 mt-0.5 shrink-0',
                  m.id === contextMode ? 'opacity-100 text-primary' : 'opacity-0',
                )}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-mono">{m.id}</span>
                  {m.thresholds?.warn !== undefined && (
                    <span className="text-[10px] text-muted-foreground tabular-nums">
                      {Math.round(m.thresholds.warn * 100)}/{Math.round(m.thresholds.soft * 100)}/
                      {Math.round(m.thresholds.hard * 100)}%
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-muted-foreground leading-snug">
                  {m.description}
                </div>
                {(m.preserveK || m.eliseThreshold) && (
                  <div className="mt-1 text-[10px] text-muted-foreground/80">
                    {t('activity:ctxMode.keepElide', { k: m.preserveK ?? '-', t: m.eliseThreshold ?? '-' })}
                  </div>
                )}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
