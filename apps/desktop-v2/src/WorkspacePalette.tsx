import { Command, CornerDownLeft, Folder, Search, Terminal, Workflow, X } from 'lucide-react';
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import { Modal } from './Modal';
import { sessionStatus, sessionTitle, visibleSessions } from './model';
import { usePaletteActions } from './palette-actions';
import type { DesktopController } from './useDesktop';
import './dialog-search.css';

export function WorkspacePalette({ vm }: { vm: DesktopController }) {
  const { t } = useDesktopText();
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const listId = `${id}-results`;
  const [index, setIndex] = useState(0);
  const query = vm.search.trim();
  const wanted = query.toLowerCase();
  const groups = [
    {
      id: 'commands',
      label: t('workspaceDialog.commands'),
      items: usePaletteActions(vm, query).map((action) => ({ ...action, Icon: Command })),
    },
    {
      id: 'projects',
      label: t('rail.projects'),
      items: vm.snapshot.projects
        .filter((project) => `${project.name} ${project.root}`.toLowerCase().includes(wanted))
        .map((project) => ({
          id: `project:${project.id}`,
          label: project.name,
          hint: project.root,
          Icon: Folder,
          run: () => vm.openProjectPage(project.id),
        })),
    },
    {
      id: 'sessions',
      label: t('workspaceDialog.sessions'),
      items: visibleSessions(vm.snapshot, null, query, 'all')
        .slice(0, 10)
        .map((session) => ({
          id: `session:${session.id}`,
          label: sessionTitle(session, t('workbench.untitled')),
          hint: t(`fleetView.status.${sessionStatus(session)}`),
          Icon: session.kind === 'terminal' ? Terminal : Workflow,
          run: () => vm.jumpToSession(session),
        })),
    },
  ];
  const options = groups.flatMap(({ items }) => items);
  const position = Math.min(index, options.length - 1);
  const active = options[position];
  const optionId = (key: string) => `${id}-${encodeURIComponent(key)}`;
  const activeId = active && optionId(active.id);
  const close = () => {
    vm.setDialog(null);
    vm.setSearch('');
  };
  const choose = (run: () => void) => {
    close();
    run();
  };
  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView?.({ block: 'nearest' });
  }, [activeId]);

  const navigate = (event: KeyboardEvent<HTMLInputElement>) => {
    if (
      event.nativeEvent.isComposing ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      !active
    )
      return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setIndex((position + step + options.length) % options.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose(active.run);
    }
  };

  return (
    <Modal className="workspace-palette" onClose={close} initialFocus={input}>
      <header>
        <h2 id="dialog-title">{t('explorer.findAnything')}</h2>
        <button
          type="button"
          className="icon-button"
          aria-label={t('workspaceDialog.close')}
          onClick={close}
        >
          <X size={18} aria-hidden="true" />
        </button>
      </header>
      <div className="dialog-search-field workspace-palette-search">
        <Search size={17} aria-hidden="true" />
        <input
          ref={input}
          role="combobox"
          aria-label={t('workspaceDialog.searchLabel')}
          aria-autocomplete="list"
          aria-expanded={!!options.length}
          aria-controls={options.length ? listId : undefined}
          aria-activedescendant={activeId}
          value={vm.search}
          autoComplete="off"
          spellCheck={false}
          placeholder={t('workspaceDialog.searchPlaceholder')}
          onChange={(event) => {
            setIndex(0);
            vm.setSearch(event.target.value);
          }}
          onKeyDown={navigate}
        />
      </div>
      <div className="workspace-palette-scroll">
        {options.length ? (
          <div role="listbox" id={listId} aria-label={t('workspaceDialog.results')}>
            {groups.map(
              ({ id: group, label, items }) =>
                items.length > 0 && (
                  // biome-ignore lint/a11y/useSemanticElements: ARIA groups contain result options in a listbox, not form fields.
                  <div
                    key={group}
                    role="group"
                    aria-labelledby={`${id}-${group}`}
                    className="workspace-palette-group"
                  >
                    <div
                      id={`${id}-${group}`}
                      className="workspace-palette-group-label"
                      aria-hidden="true"
                    >
                      {label}
                    </div>
                    {items.map((item) => (
                      <button
                        key={item.id}
                        id={optionId(item.id)}
                        type="button"
                        role="option"
                        tabIndex={-1}
                        aria-selected={active?.id === item.id}
                        onClick={() => choose(item.run)}
                      >
                        <item.Icon size={16} aria-hidden="true" />
                        <span title={item.label}>{item.label}</span>
                        {item.hint && <small title={item.hint}>{item.hint}</small>}
                        {active?.id === item.id && <CornerDownLeft size={13} aria-hidden="true" />}
                      </button>
                    ))}
                  </div>
                ),
            )}
          </div>
        ) : (
          <p role="status">{t('workspaceDialog.noResults')}</p>
        )}
        {!query && !vm.snapshot.projects.length && <p>{t('workspaceDialog.noProjects')}</p>}
      </div>
      <footer>{t('workspaceDialog.keyboardNavigation')}</footer>
    </Modal>
  );
}
