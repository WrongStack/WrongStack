import { ArrowRight, ChevronDown } from 'lucide-react';
import { useCallback, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppTranslation } from '@/i18n';
import {
  buildDesignExtractPrompt,
  DESIGN_EXTRACT_PAGES,
  DESIGN_PRESET_SITES,
  type DesignExtractPageCount,
  type DesignExtractWorkflow,
} from '@/lib/design-dna-message';
import { cn } from '@/lib/utils';
import { getWSClient } from '@/lib/ws-client';
import { useChatStore, useConfigStore } from '@/stores';
import { LauncherArt } from './WorkbenchArt';

export function WelcomeDesignLauncher({
  foldable,
  expanded,
  onToggle,
  savedCount,
}: {
  foldable: boolean;
  expanded: boolean;
  onToggle: () => void;
  savedCount: number | undefined;
}) {
  const { t } = useAppTranslation();
  const wsConnected = useConfigStore((s) => s.wsConnected);
  const wsUrl = useConfigStore((s) => s.wsUrl);
  const { addMessage, setLoading } = useChatStore(
    useShallow((s) => ({ addMessage: s.addMessage, setLoading: s.setLoading })),
  );
  const [designSource, setDesignSource] = useState('https://stripe.com');
  const [designPages, setDesignPages] = useState<DesignExtractPageCount>(6);
  const [designWorkflow, setDesignWorkflow] = useState<DesignExtractWorkflow>('extract');

  const startDesignExtract = useCallback(() => {
    const client = getWSClient(wsUrl);
    if (!client.isConnected) return;
    const content = buildDesignExtractPrompt({
      source: designSource,
      maxPages: designPages,
      workflow: designWorkflow,
    });
    const id = client.sendMessage(content);
    addMessage({ id, role: 'user', content });
    setLoading(true);
  }, [addMessage, designPages, designSource, designWorkflow, setLoading, wsUrl]);

  const headerBody = (
    <>
      <span className="ws-launcher-art flex items-center justify-center">
        <LauncherArt kind="design" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold">{t('setup:welcome.design.title')}</span>
        <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
          {t('setup:welcome.design.body')}
        </span>
      </span>
    </>
  );

  return (
    <div className="ws-launcher-card ws-launcher-card--design border border-border p-4">
      {foldable ? (
        <button
          type="button"
          data-testid="welcome-launcher-design"
          aria-expanded={expanded}
          onClick={onToggle}
          className="flex w-full items-center gap-3 text-left"
        >
          {headerBody}
          <ChevronDown
            className={cn(
              'h-4 w-4 shrink-0 text-muted-foreground transition-transform',
              expanded && 'rotate-180',
            )}
            aria-hidden
          />
        </button>
      ) : (
        <div className="flex items-center gap-3">{headerBody}</div>
      )}
      {expanded && (
        <div className="ws-launcher-fields mt-4 grid gap-2.5">
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
            {(
              [
                ['1', 'stageCrawl'],
                ['2', 'stageSubpages'],
                ['3', 'stageSynthesis'],
                ['4', 'stageSpec'],
              ] as const
            ).map(([step, key]) => (
              <div
                key={step}
                className="flex items-center gap-1.5 rounded border border-border/60 bg-background/60 px-2.5 py-1.5 text-[11px] text-muted-foreground"
              >
                <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-primary/15 font-mono text-[10px] font-semibold text-primary">
                  {step}
                </span>
                <span className="truncate font-medium text-foreground/90">
                  {t(`setup:welcome.design.${key}`)}
                </span>
              </div>
            ))}
          </div>
          <div className="grid gap-2 sm:grid-cols-[minmax(0,1.4fr)_auto_minmax(0,1fr)]">
            <label className="sr-only" htmlFor="design-extract-source">
              {t('setup:welcome.design.sourceLabel')}
            </label>
            <input
              id="design-extract-source"
              type="text"
              value={designSource}
              onChange={(event) => setDesignSource(event.target.value)}
              placeholder="https://stripe.com"
              disabled={!wsConnected}
              className="min-w-0 rounded-md border border-border bg-background px-3 py-2 font-mono text-sm"
            />
            <label className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm">
              <span className="whitespace-nowrap text-muted-foreground">
                {t('setup:welcome.design.pagesLabel')}
              </span>
              <select
                aria-label={t('setup:welcome.design.pagesLabel')}
                value={designPages}
                onChange={(event) =>
                  setDesignPages(Number(event.target.value) as DesignExtractPageCount)
                }
                disabled={!wsConnected}
                className="min-w-0 bg-transparent font-semibold outline-none"
              >
                {DESIGN_EXTRACT_PAGES.map((count) => (
                  <option key={count} value={count}>
                    {count}
                  </option>
                ))}
              </select>
            </label>
            <label className="sr-only" htmlFor="design-extract-workflow">
              {t('setup:welcome.design.workflowLabel')}
            </label>
            <select
              id="design-extract-workflow"
              value={designWorkflow}
              onChange={(event) => setDesignWorkflow(event.target.value as DesignExtractWorkflow)}
              disabled={!wsConnected}
              className="min-w-0 rounded-md border border-border bg-background px-3 py-2 text-sm"
            >
              <option value="extract">{t('setup:welcome.design.workflowExtract')}</option>
              <option value="materialize-web">
                {t('setup:welcome.design.workflowMaterializeWeb')}
              </option>
              <option value="materialize-rn">
                {t('setup:welcome.design.workflowMaterializeRn')}
              </option>
            </select>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <span>{t('setup:welcome.design.presets')}</span>
              {DESIGN_PRESET_SITES.map((site) => (
                <button
                  key={site.url}
                  type="button"
                  onClick={() => setDesignSource(site.url)}
                  disabled={!wsConnected}
                  className="rounded border border-border/70 bg-background px-2 py-0.5 font-mono text-[11px] text-foreground/85 hover:border-primary/50 hover:text-primary transition-colors"
                >
                  {site.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={startDesignExtract}
              disabled={!wsConnected || savedCount === 0 || !designSource.trim()}
              className="group flex items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t('setup:welcome.design.start')}
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
