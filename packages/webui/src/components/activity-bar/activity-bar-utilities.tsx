import {
  Bot,
  Command,
  Keyboard,
  Layers,
  LayoutGrid,
  MoreHorizontal,
  Network,
  Palette,
  Settings as SettingsIcon,
  Zap,
} from 'lucide-react';
import type { ReactElement } from 'react';
import { useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { openMainView, shortcutLabelForActivity, showPanel } from '@/lib/view-navigation';
import { useUIStore } from '@/stores';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import type { PanelDef, ViewDef } from './activity-bar-items.js';

/**
 * Bottom "More" popover collecting the app-wide utilities that used to sit as
 * loose icons in the ActivityBar: command palette, theme, keyboard shortcuts,
 * and the Fleet / Agents monitors. Keeping them behind one trigger frees four
 * vertical slots so the bar fits comfortably on short viewports.
 */
export function UtilitiesMenu({
  monitorOpen,
  hiddenPanels,
  hiddenViews,
}: {
  monitorOpen: boolean;
  /** Panels and views that are not on the rail (unpinned or overflowed). */
  hiddenPanels: PanelDef[];
  hiddenViews: ViewDef[];
}) {
  const { t } = useAppTranslation();
  const activeActivity = useUIStore((s) => s.activeActivity);
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const currentView = useUIStore((s) => s.currentView);
  const inspectorOpen = useUIStore((s) => s.inspectorOpen);
  const inspectorTab = useUIStore((s) => s.inspectorTab);
  const hiddenItemCount = hiddenPanels.length + hiddenViews.length;
  const hiddenPanelActive = hiddenPanels.some((def) => sidebarOpen && activeActivity === def.id);
  const hiddenViewActive = hiddenViews.some((def) => currentView === def.id);
  const hiddenActive = hiddenPanelActive || hiddenViewActive;

  const toggleInspectorTab = (tab: 'fleet' | 'sideEffects') => {
    const ui = useUIStore.getState();
    if (ui.inspectorOpen && ui.inspectorTab === tab) {
      ui.setInspectorOpen(false);
    } else {
      ui.setInspectorTab(tab);
      ui.setInspectorOpen(true);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={
            hiddenItemCount > 0
              ? t('activity:menu.moreWithHidden', { count: hiddenItemCount })
              : t('activity:menu.moreOptions')
          }
          title={t('activity:menu.moreFull')}
          className={cn(
            'ws-nav-button relative flex h-11 w-11 items-center justify-center rounded-md transition-colors',
            'text-muted-foreground hover:border-border/70 hover:text-foreground hover:bg-muted/60',
            'data-[state=open]:text-primary data-[state=open]:bg-primary/10 data-[state=open]:border-primary/30',
            (monitorOpen || hiddenActive) && 'text-primary',
          )}
        >
          <span className="h-5 w-5 flex items-center justify-center">
            <MoreHorizontal size={16} />
          </span>
          {hiddenItemCount > 0 && (
            <span
              className={cn(
                'absolute -top-0.5 -right-0.5 min-w-[15px] h-[15px] flex items-center justify-center rounded px-1 text-[8px] font-bold leading-none tabular',
                hiddenActive
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted-foreground text-background',
              )}
            >
              {hiddenItemCount > 9 ? '9+' : hiddenItemCount}
            </span>
          )}
          {/* Dot indicating a monitor is currently open behind the menu */}
          {monitorOpen && hiddenItemCount === 0 && (
            <span className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-primary" />
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="right" align="end" sideOffset={8} className="w-56">
        <DropdownMenuItem onSelect={() => useUIStore.getState().setPaletteOpen(true)}>
          <Command size={16} />
          <span>{t('activity:menu.commandPalette')}</span>
          <DropdownMenuShortcut>⌘K</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => useUIStore.getState().setShortcutsOpen(true)}>
          <Keyboard size={16} />
          <span>{t('activity:menu.keyboardShortcuts')}</span>
          <DropdownMenuShortcut>?</DropdownMenuShortcut>
        </DropdownMenuItem>

        {hiddenPanels.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[11px] uppercase tracking-wide text-muted-foreground">
              {t('activity:menu.panels')}
            </DropdownMenuLabel>
            {hiddenPanels.map((def) => (
              <DropdownMenuItem key={def.id} onSelect={() => showPanel(def.id)}>
                {def.icon}
                <span>{t(`activity:nav.${def.id}`, def.label)}</span>
                {sidebarOpen && activeActivity === def.id ? (
                  <span className="ml-auto w-1.5 h-1.5 rounded-full bg-primary" />
                ) : (
                  <DropdownMenuShortcut>{shortcutLabelForActivity(def.id)}</DropdownMenuShortcut>
                )}
              </DropdownMenuItem>
            ))}
          </>
        )}

        {hiddenViews.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[11px] uppercase tracking-wide text-muted-foreground">
              {t('activity:menu.views')}
            </DropdownMenuLabel>
            {hiddenViews.map((def) => (
              <DropdownMenuItem key={def.id} onSelect={() => openMainView(def.id)}>
                {def.icon}
                <span>{t(`activity:nav.${def.id}`, def.label)}</span>
                {currentView === def.id && (
                  <span className="ml-auto w-1.5 h-1.5 rounded-full bg-primary" />
                )}
              </DropdownMenuItem>
            ))}
          </>
        )}

        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-[11px] uppercase text-muted-foreground">
          {t('activity:nav.settings', 'Settings')}
        </DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => openMainView('settings')}>
          <SettingsIcon size={16} />
          <span>{t('activity:nav.settings', 'Settings')}</span>
          <span className="ml-auto text-[10px] text-muted-foreground">
            {t('settings:tabs.general', 'overview')}
          </span>
        </DropdownMenuItem>
        {[
          { icon: <Palette size={14} />, label: 'General', tab: 'general' },
          { icon: <Network size={14} />, label: 'Provider', tab: 'provider' },
          { icon: <Bot size={14} />, label: 'Agent', tab: 'agent' },
          { icon: <Zap size={14} />, label: 'Execution', tab: 'execution' },
          { icon: <Layers size={14} />, label: 'Fallbacks', tab: 'fallbacks' },
        ].map(({ icon, label, tab }) => (
          <DropdownMenuItem
            key={tab}
            onSelect={() => {
              useUIStore.getState().setSettingsActiveTab(tab);
              openMainView('settings');
            }}
          >
            {icon}
            <span>{t(`settings:tabs.${tab}`, label)}</span>
          </DropdownMenuItem>
        ))}

        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-[11px] uppercase text-muted-foreground">
          {t('activity:menu.monitors')}
        </DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => toggleInspectorTab('fleet')}>
          <LayoutGrid size={16} />
          <span>{t('activity:menu.fleetMonitor')}</span>
          {inspectorOpen && inspectorTab === 'fleet' ? (
            <span className="ml-auto w-1.5 h-1.5 rounded-full bg-primary" />
          ) : (
            <DropdownMenuShortcut>⇧⌘M</DropdownMenuShortcut>
          )}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => toggleInspectorTab('sideEffects')}>
          <Zap size={16} />
          <span>{t('activity:inspector.tabAudit')}</span>
          {inspectorOpen && inspectorTab === 'sideEffects' ? (
            <span className="ml-auto h-1.5 w-1.5 rounded-full bg-primary" />
          ) : null}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ActivityIcon({
  icon,
  label,
  active,
  badge,
  onClick,
}: {
  icon: ReactElement;
  label: string;
  active: boolean;
  badge?: number | undefined;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      title={label}
      className={cn(
        'ws-nav-button relative flex h-11 w-11 shrink-0 items-center justify-center rounded-md transition-colors',
        'text-muted-foreground hover:border-border/70 hover:text-foreground hover:bg-muted/60',
        active && 'ws-nav-button-active',
      )}
    >
      {/* Active indicator — left accent bar */}
      {active && (
        <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-6 rounded-r-full bg-primary" />
      )}
      <span className="h-5 w-5 shrink-0">{icon}</span>
      {/* Badge count — top-right pill */}
      {badge !== undefined && badge > 0 && (
        <span className="absolute -top-0.5 -right-0.5 min-w-[15px] h-[15px] flex items-center justify-center rounded bg-primary text-[8px] font-bold text-primary-foreground leading-none px-1 tabular">
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </button>
  );
}
