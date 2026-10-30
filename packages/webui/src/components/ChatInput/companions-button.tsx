import { Bot, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useWebSocket } from '@/hooks/useWebSocket';
import { useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { useLocalPrefs } from '@/stores/local-prefs';
import { ComposerPopover } from './composer-popover';

export function CompanionsButton() {
  const { t } = useAppTranslation();
  const { updatePrefs } = useWebSocket();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const { memoryCompanionEnabled, exploreCompanionEnabled, skillCompanionEnabled } = useLocalPrefs(
    useShallow((s) => ({
      memoryCompanionEnabled: s.memoryCompanionEnabled,
      exploreCompanionEnabled: s.exploreCompanionEnabled,
      skillCompanionEnabled: s.skillCompanionEnabled,
    })),
  );

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (wrapRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
        wrapRef.current?.querySelector('button')?.focus();
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const enabledCount =
    (memoryCompanionEnabled ? 1 : 0) +
    (exploreCompanionEnabled ? 1 : 0) +
    (skillCompanionEnabled ? 1 : 0);
  const allEnabled = enabledCount === 3;
  const anyEnabled = enabledCount > 0;

  const toggleCompanion = (
    key: 'memoryCompanionEnabled' | 'exploreCompanionEnabled' | 'skillCompanionEnabled',
    next: boolean,
  ) => {
    useLocalPrefs.getState().set({ [key]: next });
    updatePrefs({ [key]: next });
  };

  const toggleAll = () => {
    const next = !allEnabled;
    const patch = {
      memoryCompanionEnabled: next,
      exploreCompanionEnabled: next,
      skillCompanionEnabled: next,
    };
    useLocalPrefs.getState().set(patch);
    updatePrefs(patch);
  };

  const summary =
    enabledCount === 0
      ? t('settings:fleet.companionsSummaryOff', { defaultValue: 'off' })
      : enabledCount === 3
        ? t('settings:fleet.companionsSummaryAll', { defaultValue: 'on (3/3)' })
        : `${enabledCount}/3`;

  const items: ReadonlyArray<{
    key: 'memoryCompanionEnabled' | 'exploreCompanionEnabled' | 'skillCompanionEnabled';
    label: string;
    hint: string;
    enabled: boolean;
  }> = [
    {
      key: 'memoryCompanionEnabled',
      label: t('settings:fleet.memoryCompanionLabel', { defaultValue: 'Memory Companion' }),
      hint: t('settings:fleet.memoryCompanionHint', {
        defaultValue:
          'Resident memory-companion agent that recalls relevant memories and curates learnings in the background.',
      }),
      enabled: memoryCompanionEnabled,
    },
    {
      key: 'exploreCompanionEnabled',
      label: t('settings:fleet.exploreCompanionLabel', { defaultValue: 'Explore Companion' }),
      hint: t('settings:fleet.exploreCompanionHint', {
        defaultValue:
          'Resident explore-companion agent that runs read-only codebase exploration probes behind the leader.',
      }),
      enabled: exploreCompanionEnabled,
    },
    {
      key: 'skillCompanionEnabled',
      label: t('settings:fleet.skillCompanionLabel', { defaultValue: 'Skill Companion' }),
      hint: t('settings:fleet.skillCompanionHint', {
        defaultValue:
          'Resident skill-companion agent that evaluates your task and recommends relevant unloaded skills.',
      }),
      enabled: skillCompanionEnabled,
    },
  ];

  return (
    <span ref={wrapRef} className="relative inline-flex shrink-0">
      <button
        type="button"
        data-testid="composer-companions-button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        title={t('settings:fleet.companionsHeading', { defaultValue: 'Companion Agents' })}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs transition-all duration-200',
          anyEnabled
            ? 'border-border/50 bg-card/50 text-muted-foreground hover:border-primary/30 hover:bg-accent/50 hover:text-foreground'
            : 'border-border/40 bg-muted/30 text-muted-foreground/70 hover:border-border hover:text-foreground',
        )}
      >
        <Bot className={cn('h-3.5 w-3.5 shrink-0', anyEnabled && 'text-primary')} />
        <span className="whitespace-nowrap">
          {t('settings:fleet.companionsButtonPrefix', { defaultValue: 'Companions:' })}{' '}
          <span className="font-mono">{summary}</span>
        </span>
      </button>

      {open && (
        <ComposerPopover
          anchorRef={wrapRef}
          panelRef={panelRef}
          data-testid="composer-companions-popover"
        >
          <div className="mb-2.5 flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold">
                {t('settings:fleet.companionsHeading', { defaultValue: 'Companion Agents' })}
              </p>
              <p className="text-[10px] leading-tight text-muted-foreground">
                {t('settings:fleet.companionsHint', {
                  defaultValue:
                    'Toggle resident background companions individually; changes take effect immediately.',
                })}
              </p>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                data-testid="composer-companions-toggle-all"
                onClick={toggleAll}
                className="rounded border border-border/70 bg-card/60 px-2 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
              >
                {allEnabled
                  ? t('settings:fleet.companionsToggleAllOff', { defaultValue: 'Turn all off' })
                  : t('settings:fleet.companionsToggleAllOn', { defaultValue: 'Turn all on' })}
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label={t('common:action.close', { defaultValue: 'Close' })}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          <div className="divide-y divide-border/50">
            {items.map((item) => (
              <div key={item.key} className="flex items-start justify-between gap-2.5 py-2">
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-medium leading-tight">{item.label}</div>
                  <div className="mt-0.5 text-[10px] leading-snug text-muted-foreground">
                    {item.hint}
                  </div>
                </div>
                <button
                  type="button"
                  role="switch"
                  data-testid={`composer-companion-switch-${item.key}`}
                  aria-checked={item.enabled}
                  aria-label={item.label}
                  onClick={() => toggleCompanion(item.key, !item.enabled)}
                  className={cn(
                    'relative mt-0.5 inline-flex h-5 w-9 shrink-0 rounded-full border transition-colors',
                    item.enabled
                      ? 'border-primary bg-primary'
                      : 'border-input bg-muted hover:bg-muted/80',
                  )}
                >
                  <span
                    className={cn(
                      'absolute top-0.5 left-0.5 h-3.5 w-3.5 rounded-full bg-background shadow transition-transform',
                      item.enabled && 'translate-x-4',
                    )}
                  />
                </button>
              </div>
            ))}
          </div>
        </ComposerPopover>
      )}
    </span>
  );
}
