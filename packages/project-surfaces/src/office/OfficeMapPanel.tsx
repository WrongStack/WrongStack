/**
 * OfficeMapPanel — Side panel wrapper for the office map canvas.
 * Wraps OfficeMapCanvas with ReactFlowProvider.
 */

import { ReactFlowProvider } from '@xyflow/react';
import { Network, PanelsTopLeft } from 'lucide-react';
import type { KeyboardEvent } from 'react';
import { useAppTranslation } from '../lib/i18n';
import { cn } from '../lib/utils';
import { AgentOfficeView } from './AgentOfficeView';
import { OfficeMapCanvas } from './OfficeMapCanvas';
import { useOfficeMapStore } from './office-map-store';

export function OfficeMapPanel() {
  const { t } = useAppTranslation();
  const viewMode = useOfficeMapStore((state) => state.viewMode);
  const setViewMode = useOfficeMapStore((state) => state.setViewMode);
  const views = [
    {
      id: 'office' as const,
      label: t('activity:agentOffice.office'),
      description: t('activity:agentOffice.officeDescription'),
      icon: PanelsTopLeft,
    },
    {
      id: 'topology' as const,
      label: t('activity:agentOffice.topology'),
      description: t('activity:agentOffice.topologyDescription'),
      icon: Network,
    },
  ];

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | undefined;
    if (event.key === 'ArrowLeft') nextIndex = (index - 1 + views.length) % views.length;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % views.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = views.length - 1;
    if (nextIndex === undefined) return;

    event.preventDefault();
    const nextView = views[nextIndex];
    if (!nextView) return;
    setViewMode(nextView.id);
    event.currentTarget.parentElement
      ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
      [nextIndex]?.focus();
  };

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-background">
      <nav
        aria-label={`${t('activity:agentOffice.office')} / ${t('activity:agentOffice.topology')}`}
        className="relative z-[60] shrink-0 border-b border-border bg-card/95 px-3 pt-2 shadow-[0_8px_28px_hsl(var(--shadow-color)/0.1)] backdrop-blur-xl sm:px-5"
      >
        <div
          role="tablist"
          aria-orientation="horizontal"
          className="mx-auto grid w-full max-w-3xl grid-cols-2 gap-1"
        >
          {views.map((view, index) => {
            const Icon = view.icon;
            const isActive = viewMode === view.id;
            return (
              <button
                key={view.id}
                id={`office-map-tab-${view.id}`}
                type="button"
                role="tab"
                aria-selected={isActive}
                aria-controls="office-map-view-panel"
                tabIndex={isActive ? 0 : -1}
                onClick={() => setViewMode(view.id)}
                onKeyDown={(event) => handleTabKeyDown(event, index)}
                className={cn(
                  'group relative flex min-w-0 items-center gap-2.5 border-b-2 px-3 py-2.5 text-left transition-all duration-200 sm:gap-3 sm:px-5',
                  isActive
                    ? 'border-primary bg-primary/[0.07] text-foreground'
                    : 'border-transparent text-muted-foreground hover:border-border hover:bg-accent/60 hover:text-foreground',
                )}
              >
                <span
                  className={cn(
                    'grid h-8 w-8 shrink-0 place-items-center rounded-lg border transition-colors',
                    isActive
                      ? 'border-primary/35 bg-primary/15 text-primary'
                      : 'border-border bg-background/70 text-muted-foreground group-hover:text-foreground',
                  )}
                >
                  <Icon className="h-4 w-4" aria-hidden="true" />
                </span>
                <span className="min-w-0">
                  <strong className="block truncate font-display text-xs font-semibold sm:text-sm">
                    {view.label}
                  </strong>
                  <small className="hidden truncate font-mono text-[9px] font-normal text-muted-foreground sm:block">
                    {view.description}
                  </small>
                </span>
                <span
                  aria-hidden="true"
                  className={cn(
                    'ml-auto h-1.5 w-1.5 shrink-0 rounded-full transition-all',
                    isActive
                      ? 'bg-primary shadow-[0_0_0_4px_hsl(var(--primary)/0.12)]'
                      : 'bg-border',
                  )}
                />
              </button>
            );
          })}
        </div>
      </nav>

      <div
        id="office-map-view-panel"
        role="tabpanel"
        aria-labelledby={`office-map-tab-${viewMode}`}
        className="relative min-h-0 flex-1"
      >
        {viewMode === 'office' ? (
          <AgentOfficeView />
        ) : (
          <ReactFlowProvider>
            <OfficeMapCanvas />
          </ReactFlowProvider>
        )}
      </div>
    </div>
  );
}
