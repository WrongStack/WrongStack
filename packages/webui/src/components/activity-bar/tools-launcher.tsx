/**
 * ToolsLauncher — calm-chrome home for every standalone view.
 *
 * Under calm chrome the activity bar keeps the six panels and the first few
 * main views of the user's order; this one button opens a grouped map of
 * ALL tools — including the views that never had a bar icon (sessions,
 * context, analytics, dead code, requirements, debug). Full chrome does not
 * render it: there every view keeps its own icon or "…" overflow slot.
 */

import {
  BarChart3,
  Bot,
  Boxes,
  BrainCircuit,
  Bug,
  ChartNoAxesCombined,
  ClipboardList,
  Columns3,
  FlaskConical,
  Gauge,
  GitFork,
  History,
  Layers,
  LayoutGrid,
  Network,
  PackageOpen,
  Pencil,
  Rocket,
  Scissors,
  Settings as SettingsIcon,
  ShieldAlert,
  SquareStack,
  Wand2,
} from 'lucide-react';
import type { ReactElement } from 'react';
import { useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { type AppView, navigateToView } from '@/lib/view-navigation';
import { useUIStore } from '@/stores';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { ACTIVITY_BAR_MAX_ICONS } from './activity-bar-pins.js';

interface ToolDef {
  view: AppView;
  icon: ReactElement;
  /** i18n key under `activity:` for the label. */
  labelKey: string;
}

interface ToolGroup {
  key: 'work' | 'knowledge' | 'quality' | 'system';
  tools: ToolDef[];
}

/** The launcher map. Every standalone view appears exactly once. */
const TOOL_GROUPS: readonly ToolGroup[] = [
  {
    key: 'work',
    tools: [
      { view: 'roster', icon: <Bot size={15} />, labelKey: 'nav.roster' },
      { view: 'goal', icon: <Rocket size={15} />, labelKey: 'nav.goal' },
      { view: 'kanban', icon: <Columns3 size={15} />, labelKey: 'nav.kanban' },
      { view: 'sddhub', icon: <Wand2 size={15} />, labelKey: 'nav.sddhub' },
      { view: 'intake', icon: <ClipboardList size={15} />, labelKey: 'nav.intake' },
      { view: 'project-kit', icon: <PackageOpen size={15} />, labelKey: 'nav.project-kit' },
      { view: 'automation', icon: <Rocket size={15} />, labelKey: 'nav.automation' },
    ],
  },
  {
    key: 'knowledge',
    tools: [
      { view: 'memory', icon: <BrainCircuit size={15} />, labelKey: 'nav.memory' },
      { view: 'codemap', icon: <Network size={15} />, labelKey: 'nav.codemap' },
      { view: 'history', icon: <GitFork size={15} />, labelKey: 'nav.history' },
      { view: 'chronicle', icon: <ChartNoAxesCombined size={15} />, labelKey: 'nav.chronicle' },
      { view: 'prompts', icon: <History size={15} />, labelKey: 'nav.prompts' },
    ],
  },
  {
    key: 'quality',
    tools: [
      { view: 'chimera', icon: <ShieldAlert size={15} />, labelKey: 'nav.chimera' },
      { view: 'techstack', icon: <Boxes size={15} />, labelKey: 'nav.techstack' },
      { view: 'deadcode', icon: <Scissors size={15} />, labelKey: 'panels.deadcode' },
      { view: 'analytics', icon: <BarChart3 size={15} />, labelKey: 'panels.analytics' },
    ],
  },
  {
    key: 'system',
    tools: [
      { view: 'sessions', icon: <SquareStack size={15} />, labelKey: 'panels.sessions' },
      { view: 'context', icon: <Layers size={15} />, labelKey: 'panels.contextDashboard' },
      { view: 'provider-test', icon: <FlaskConical size={15} />, labelKey: 'nav.provider-test' },
      { view: 'provider-quota', icon: <Gauge size={15} />, labelKey: 'nav.provider-quota' },
      { view: 'debug', icon: <Bug size={15} />, labelKey: 'panels.debugDashboard' },
      { view: 'settings', icon: <SettingsIcon size={15} />, labelKey: 'nav.settings' },
    ],
  },
];

export function ToolsLauncher({
  onCustomize,
  variant = 'rail',
}: {
  /** Enter the activity bar's reorder mode (choose which views stay on the bar). */
  onCustomize: () => void;
  variant?: 'rail' | 'mobile';
}) {
  const { t } = useAppTranslation();
  const currentView = useUIStore((s) => s.currentView);
  const activeInLauncher = TOOL_GROUPS.some((g) => g.tools.some((d) => d.view === currentView));
  const label = t('activity:launcher.title');
  const mobile = variant === 'mobile';

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid={
            mobile ? 'mobile-activity-bar-tools-launcher' : 'activity-bar-tools-launcher'
          }
          aria-label={label}
          title={label}
          className={cn(
            'ws-nav-button relative flex shrink-0 items-center justify-center transition-colors',
            mobile
              ? 'min-h-12 min-w-0 flex-col gap-0.5 px-1 text-[10px] font-medium'
              : 'h-11 w-11 rounded-md',
            'text-muted-foreground hover:border-border/70 hover:text-foreground hover:bg-muted/60',
            'data-[state=open]:text-primary data-[state=open]:bg-primary/10',
            activeInLauncher && 'text-primary',
          )}
        >
          <span className="flex h-5 w-5 items-center justify-center">
            <LayoutGrid size={16} />
          </span>
          {mobile && <span className="max-w-full truncate">{label}</span>}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side={mobile ? 'top' : 'right'}
        align={mobile ? 'end' : 'start'}
        sideOffset={8}
        className="w-[min(30rem,calc(100vw-2rem))] p-2"
      >
        <div className="grid grid-cols-1 gap-x-2 gap-y-1 sm:grid-cols-2">
          {TOOL_GROUPS.map((group) => (
            <div key={group.key} data-testid={`launcher-group-${group.key}`} className="min-w-0">
              <DropdownMenuLabel className="text-[11px] uppercase text-muted-foreground">
                {t(`activity:launcher.groups.${group.key}`)}
              </DropdownMenuLabel>
              {group.tools.map((tool) => (
                <DropdownMenuItem
                  key={tool.view}
                  data-testid={`launcher-item-${tool.view}`}
                  onSelect={() => navigateToView(tool.view)}
                  className="gap-2"
                >
                  {tool.icon}
                  <span className="truncate">{t(`activity:${tool.labelKey}`)}</span>
                  {currentView === tool.view ? (
                    <span className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                  ) : null}
                </DropdownMenuItem>
              ))}
            </div>
          ))}
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onCustomize} className="gap-2 text-muted-foreground">
          <Pencil size={14} />
          <span>{t('activity:launcher.customize', { max: ACTIVITY_BAR_MAX_ICONS })}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
