import { ArrowRight, Zap } from 'lucide-react';
import { desktopCommands } from './desktop-commands';
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
function paletteActions(vm: DesktopController): PaletteAction[] {
  const project = vm.project ?? vm.snapshot.projects[0]?.id;
  const pages = project
    ? desktopCommands.flatMap((command) => {
        const target = command.action === 'open' ? command.opens : undefined;
        return target && 'page' in target
          ? [
              {
                id: `page:${target.page}`,
                label: command.description,
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
            label: 'Start a new agent session',
            hint: 'Ctrl N',
            run: () => vm.newSession(project),
          },
          {
            id: 'new-terminal',
            label: 'Open a new terminal',
            run: () => vm.newSession(project, 'terminal'),
          },
        ]
      : []),
    {
      id: 'settings',
      label: 'Open WrongStack settings',
      hint: '/settings',
      run: () => vm.openWrongStackSettings(),
    },
    {
      id: 'mode',
      label: dark ? 'Switch to light mode' : 'Switch to dark mode',
      run: () => vm.changeAppearance({ mode: dark ? 'light' : 'dark' }),
    },
    {
      id: 'density',
      label:
        vm.appearance.density === 'compact'
          ? 'Use comfortable conversation density'
          : 'Use compact conversation density',
      run: () =>
        vm.changeAppearance({
          density: vm.appearance.density === 'compact' ? undefined : 'compact',
        }),
    },
    {
      id: 'sound',
      label: vm.appearance.sound === 'on' ? 'Turn run sounds off' : 'Chime when a run finishes',
      run: () => vm.changeAppearance({ sound: vm.appearance.sound === 'on' ? undefined : 'on' }),
    },
    ...pages,
  ];
}

export function PaletteActions({ vm, search }: { vm: DesktopController; search: string }) {
  const wanted = search.trim().toLowerCase();
  const actions = paletteActions(vm).filter(
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
          <small>{action.hint ?? 'ACTION'}</small>
          <ArrowRight size={15} />
        </button>
      ))}
    </>
  );
}
