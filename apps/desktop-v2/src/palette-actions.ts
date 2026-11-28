import {
  Bell,
  BellOff,
  Gauge,
  type LucideIcon,
  Moon,
  PanelsTopLeft,
  Rows3,
  Settings,
  SquareArrowOutUpRight,
  Sun,
  Terminal,
  Workflow,
} from 'lucide-react';
import { commandDescription } from './desktop-command-text';
import { desktopCommands } from './desktop-commands';
import { useDesktopText } from './desktop-i18n';
import { usePaneLayout } from './pane-layout-context';
import { projectTools } from './project-tools';
import { requestSettingsSection } from './settings-section-request';
import type { DesktopController } from './useDesktop';

interface PaletteAction {
  id: string;
  label: string;
  /** What the row shows on its right: a keyboard shortcut. */
  hint?: string | undefined;
  /** Extra words the search matches but the row does not show (a page's slash command). */
  keywords?: string | undefined;
  /** What the action does, as its row's icon. */
  Icon: LucideIcon;
  run: () => void;
}

/** With nothing typed the palette lists only its first few actions; typing searches them all. */
const IDLE_ACTIONS = 6;

/**
 * Actions in the Ctrl+K palette, as the WebUI's command palette has them beside its search:
 * start a session or terminal, open any of the current project's pages (what the slash commands
 * open), WrongStack settings, and flip the light or dark mode, density and run sounds.
 */
function paletteActions(
  vm: DesktopController,
  t: ReturnType<typeof useDesktopText>['t'],
): PaletteAction[] {
  const project = vm.project ?? vm.snapshot.projects[0]?.id;
  const pages = project
    ? desktopCommands.flatMap((command) => {
        const target = command.action === 'open' ? command.opens : undefined;
        return target && 'page' in target
          ? [
              {
                id: `page:${command.name}`,
                label: commandDescription(command, t),
                keywords: command.name,
                Icon:
                  projectTools.find((each) => each.id === target.page)?.Icon ??
                  SquareArrowOutUpRight,
                run: () => vm.openProjectPage(project, target.page),
              },
            ]
          : [];
      })
    : [];
  const dark = vm.mode === 'dark';
  return [
    ...(project
      ? [
          {
            id: 'new-agent',
            label: t('paletteActions.newAgent'),
            hint: 'Ctrl N',
            Icon: Workflow,
            run: () => vm.newSession(project),
          },
          {
            id: 'new-terminal',
            label: t('paletteActions.newTerminal'),
            Icon: Terminal,
            run: () => vm.newSession(project, 'terminal'),
          },
        ]
      : []),
    {
      id: 'settings',
      label: t('paletteActions.settings'),
      keywords: '/settings',
      Icon: Settings,
      run: () => vm.openWrongStackSettings(),
    },
    {
      id: 'quota',
      label: t('paletteActions.quota'),
      Icon: Gauge,
      run: () => {
        requestSettingsSection('quota');
        vm.openWrongStackSettings();
      },
    },
    {
      id: 'mode',
      label: dark ? t('paletteActions.light') : t('paletteActions.dark'),
      Icon: dark ? Sun : Moon,
      run: () => vm.changeAppearance({ mode: dark ? 'light' : 'dark' }),
    },
    {
      id: 'density',
      Icon: Rows3,
      label:
        vm.appearance.density === 'compact'
          ? t('paletteActions.comfortable')
          : t('paletteActions.compact'),
      run: () =>
        vm.changeAppearance({
          density: vm.appearance.density === 'compact' ? undefined : 'compact',
        }),
    },
    {
      id: 'sound',
      Icon: vm.appearance.sound === 'on' ? BellOff : Bell,
      label:
        vm.appearance.sound === 'on' ? t('paletteActions.soundsOff') : t('paletteActions.chime'),
      run: () => vm.changeAppearance({ sound: vm.appearance.sound === 'on' ? undefined : 'on' }),
    },
    ...pages,
  ];
}

export function usePaletteActions(vm: DesktopController, search: string) {
  const { t } = useDesktopText();
  const wanted = search.trim().toLowerCase();
  const layout = usePaneLayout();
  const layoutAction: PaletteAction[] = layout
    ? [
        {
          id: 'pane-layout',
          label: t('workspaceDialog.layout'),
          Icon: PanelsTopLeft,
          run: layout.showSettings,
        },
      ]
    : [];
  const actions = [...layoutAction, ...paletteActions(vm, t)].filter(
    (action) =>
      !wanted ||
      action.label.toLowerCase().includes(wanted) ||
      (action.hint?.toLowerCase().includes(wanted) ?? false) ||
      (action.keywords?.toLowerCase().includes(wanted) ?? false),
  );
  return wanted ? actions : actions.slice(0, IDLE_ACTIONS);
}
