import { ArrowRight, Zap } from 'lucide-react';
import { commandDescription } from './desktop-command-text';
import { desktopCommands } from './desktop-commands';
import { useDesktopText } from './desktop-i18n';
import type { DesktopController } from './useDesktop';

interface PaletteAction {
  id: string;
  label: string;
  hint?: string | undefined;
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
                id: `page:${target.page}`,
                label: commandDescription(command, t),
                hint: command.name,
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
            run: () => vm.newSession(project),
          },
          {
            id: 'new-terminal',
            label: t('paletteActions.newTerminal'),
            run: () => vm.newSession(project, 'terminal'),
          },
        ]
      : []),
    {
      id: 'settings',
      label: t('paletteActions.settings'),
      hint: '/settings',
      run: () => vm.openWrongStackSettings(),
    },
    {
      id: 'mode',
      label: dark ? t('paletteActions.light') : t('paletteActions.dark'),
      run: () => vm.changeAppearance({ mode: dark ? 'light' : 'dark' }),
    },
    {
      id: 'density',
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
      label:
        vm.appearance.sound === 'on' ? t('paletteActions.soundsOff') : t('paletteActions.chime'),
      run: () => vm.changeAppearance({ sound: vm.appearance.sound === 'on' ? undefined : 'on' }),
    },
    ...pages,
  ];
}

export function PaletteActions({ vm, search }: { vm: DesktopController; search: string }) {
  const { t } = useDesktopText();
  const wanted = search.trim().toLowerCase();
  const actions = paletteActions(vm, t).filter(
    (action) =>
      !wanted ||
      action.label.toLowerCase().includes(wanted) ||
      (action.hint?.toLowerCase().includes(wanted) ?? false),
  );
  const shown = wanted ? actions : actions.slice(0, IDLE_ACTIONS);
  if (!shown.length) return null;
  return (
    <>
      {shown.map((action) => (
        <button
          type="button"
          key={action.id}
          onClick={() => {
            vm.setDialog(null);
            vm.setSearch('');
            action.run();
          }}
        >
          <Zap size={17} />
          <span>{action.label}</span>
          <small>{action.hint ?? t('paletteActions.action')}</small>
          <ArrowRight size={15} />
        </button>
      ))}
    </>
  );
}
