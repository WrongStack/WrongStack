import { useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { showPanel } from '@/lib/view-navigation';
import { useUIStore } from '@/stores';
import { PANELS } from './activity-bar-items';
import { ToolsLauncher } from './tools-launcher';

const MOBILE_PANEL_IDS = new Set(['chat', 'files', 'changes', 'skills']);

export function MobileActivityBar({ onCustomize }: { onCustomize: () => void }) {
  const { t } = useAppTranslation();
  const activeActivity = useUIStore((s) => s.activeActivity);
  const currentView = useUIStore((s) => s.currentView);
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const panels = PANELS.filter((panel) => MOBILE_PANEL_IDS.has(panel.id));

  return (
    <nav
      aria-label={t('activity:sidebar.label')}
      data-testid="mobile-activity-bar"
      className="fixed inset-x-0 bottom-0 z-40 grid h-[calc(3.5rem+env(safe-area-inset-bottom,0px))] grid-cols-5 border-t border-border/70 bg-card/95 pb-[env(safe-area-inset-bottom,0px)] backdrop-blur-xl md:hidden"
    >
      {panels.map((panel) => {
        const label = t(`activity:nav.${panel.id}`, panel.label);
        const active = currentView === panel.id || (sidebarOpen && activeActivity === panel.id);
        return (
          <button
            key={panel.id}
            type="button"
            aria-label={label}
            aria-pressed={active}
            onClick={() => showPanel(panel.id)}
            className={cn(
              'relative flex min-h-12 min-w-0 flex-col items-center justify-center gap-0.5 px-1 text-[10px] font-medium transition-colors',
              active ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted/50',
            )}
          >
            <span className="flex h-5 w-5 items-center justify-center" aria-hidden="true">
              {panel.icon}
            </span>
            <span className="max-w-full truncate">{label}</span>
          </button>
        );
      })}
      <ToolsLauncher onCustomize={onCustomize} variant="mobile" />
    </nav>
  );
}
