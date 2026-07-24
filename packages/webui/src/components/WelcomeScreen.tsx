
import { useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { getWSClient } from '@/lib/ws-client';
import { openMainView } from '@/lib/view-navigation';
import { useConfigStore, useSessionStore } from '@/stores';
import type { WSServerMessage } from '@/types';
import { ArrowRight, KeyRound } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';

export function WelcomeScreen() {
  const { t } = useAppTranslation();
  const { projectName, cwd } = useSessionStore(
    useShallow((s) => ({ projectName: s.projectName, cwd: s.cwd })),
  );
  const { provider, model } = useConfigStore(
    useShallow((s) => ({ provider: s.provider, model: s.model })),
  );
  const wsConnected = useConfigStore((s) => s.wsConnected);
  const wsUrl = useConfigStore((s) => s.wsUrl);
  const [savedCount, setSavedCount] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (!wsConnected) return;
    const client = getWSClient(wsUrl);
    const off = client.on('providers.saved', (msg: WSServerMessage) => {
      const p = msg.payload as { providers: unknown[] };
      setSavedCount(p.providers?.length ?? 0);
    });
    client.listSavedProviders();
    return () => {
      off();
    };
  }, [wsConnected, wsUrl]);

  return (
    <div className="flex flex-col gap-5 py-5 sm:py-7 max-w-6xl mx-auto w-full">
      {/* ── Session start panel ── */}
      <div className="ws-surface relative overflow-hidden rounded-xl p-5 sm:p-6">
        {/* Decorative gradient blob — subtle visual depth */}
        <div className="absolute -top-24 -right-24 w-72 h-72 rounded-full bg-gradient-to-br from-primary/8 via-primary/5 to-transparent blur-3xl pointer-events-none" />
        <div className="absolute -bottom-12 -left-12 w-48 h-48 rounded-full bg-gradient-to-tr from-accent/8 to-transparent blur-3xl pointer-events-none" />

        <div className="relative flex flex-col gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <img
              src="/wrongstack.svg"
              alt="WrongStack"
              draggable={false}
              className="ws-brand-logo h-16 w-16 shrink-0 border border-border/70 shadow-sm shadow-primary/20 sm:h-20 sm:w-20"
            />
            <div className="min-w-0">
              <h2 className="text-xl font-semibold tracking-tight">
                {projectName
                  ? t('setup:welcome.heroTitleInProject', { name: projectName })
                  : t('setup:welcome.heroTitle')}
              </h2>
              <p className="mt-1 text-sm text-muted-foreground leading-relaxed">
                {t('setup:welcome.heroSubtitle')}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 pl-[76px] sm:pl-[92px]">
            {provider && model && (
              <p className="truncate text-xs text-muted-foreground/80 font-mono">
                {provider} / {model}
              </p>
            )}
            {cwd && (
              <p className="truncate text-[11px] text-muted-foreground/75 font-mono" title={cwd}>
                {t('setup:welcome.workingDirectory', { cwd })}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* ── No-keys CTA ── */}
      {wsConnected && savedCount === 0 && (
        <button
          type="button"
          onClick={() => openMainView('settings')}
          className={cn(
            'group rounded-xl border bg-gradient-to-r from-warning/5 to-warning/[0.02]',
            'border-warning/30 hover:border-warning/50 transition-all duration-200 shadow-sm',
            'p-5 flex items-center gap-4 text-left animate-message',
          )}
        >
          <span className="flex items-center justify-center w-11 h-11 rounded-lg bg-gradient-to-br from-warning/20 to-warning/10 text-warning shrink-0 shadow-sm shadow-warning/10">
            <KeyRound className="h-6 w-6" />
          </span>
          <div className="flex-1 min-w-0">
            <h3 className="text-base font-semibold mb-1">{t('setup:welcome.noKeyTitle')}</h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              {t('setup:welcome.noKeyBody')}
            </p>
          </div>
          <span className="flex items-center gap-1 text-xs text-warning font-medium shrink-0 group-hover:translate-x-0.5 transition-transform">
            {t('setup:welcome.openSettings')} <ArrowRight className="h-3.5 w-3.5" />
          </span>
        </button>
      )}
    </div>
  );
}
