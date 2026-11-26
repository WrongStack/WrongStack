import {
  ChevronDown,
  Command,
  FileCode2,
  GitCompareArrows,
  Menu,
  PanelLeft,
  Plus,
  Terminal,
} from 'lucide-react';
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import { paneLayoutTitle } from './PaneLayoutDialog';
import { usePaneLayout } from './pane-layout-context';
import { native } from './platform';
import type { DesktopController } from './useDesktop';
import type { WorkbenchExplorer } from './useWorkbenchExplorer';
import './workbench-menu.css';

export function WorkbenchMenu({
  vm,
  explorer,
}: {
  vm: DesktopController;
  explorer: WorkbenchExplorer;
}) {
  const { t } = useDesktopText();
  const layout = usePaneLayout();
  const id = useId();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const startAtEnd = useRef(false);
  const label = t('shortcutsView.group.desktop');
  const project = vm.currentProject?.id ?? vm.snapshot.projects[0]?.id;
  const sessionDisabled = !native || !project || vm.pending;
  const items = () =>
    Array.from(popup.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);

  useEffect(() => {
    if (!open) return;
    const available = Array.from(
      popup.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [],
    );
    (startAtEnd.current ? available.at(-1) : available[0])?.focus();
    const dismiss = (event: Event) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('focusin', dismiss);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('focusin', dismiss);
    };
  }, [open]);

  function choose(action: () => void) {
    setOpen(false);
    trigger.current?.focus();
    action();
  }

  function onKeys(event: KeyboardEvent<HTMLDivElement>) {
    if (!open) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
      return;
    }
    const available = items();
    const focused = document.activeElement;
    const index = focused instanceof HTMLButtonElement ? available.indexOf(focused) : -1;
    let next: number;
    switch (event.key) {
      case 'ArrowDown':
        next = (index + 1) % available.length;
        break;
      case 'ArrowUp':
        next = index < 0 ? available.length - 1 : (index - 1 + available.length) % available.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = available.length - 1;
        break;
      case 'Tab':
        trigger.current?.focus();
        setOpen(false);
        return;
      default:
        return;
    }
    event.preventDefault();
    available[next]?.focus();
  }

  return (
    <div className="workbench-menu" ref={root}>
      <button
        type="button"
        ref={trigger}
        className="workbench-menu-trigger"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => {
          startAtEnd.current = false;
          setOpen(!open);
        }}
        onKeyDown={(event) => {
          if (open || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return;
          event.preventDefault();
          startAtEnd.current = event.key === 'ArrowUp';
          setOpen(true);
        }}
      >
        <span>{label}</span>
        <ChevronDown className="workbench-menu-caret" size={14} aria-hidden="true" />
        <Menu className="workbench-menu-icon" size={14} aria-hidden="true" />
      </button>
      {open && (
        <div
          className="workbench-menu-popup"
          id={id}
          role="menu"
          aria-label={label}
          ref={popup}
          onKeyDown={onKeys}
        >
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            onClick={() =>
              choose(() => {
                vm.setSearch('');
                vm.setDialog('palette');
              })
            }
          >
            <Command size={15} aria-hidden="true" />
            <span>{t('explorer.findAnything')}</span>
            <kbd>Ctrl K</kbd>
          </button>
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={explorer.open}
            tabIndex={-1}
            onClick={() => choose(explorer.toggle)}
          >
            <PanelLeft size={15} aria-hidden="true" />
            <span>{t('explorer.toggle')}</span>
            <kbd>Ctrl B</kbd>
          </button>
          {layout && (
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              onClick={() => choose(layout.showSettings)}
            >
              <PanelLeft size={15} aria-hidden="true" />
              <span>{paneLayoutTitle}</span>
            </button>
          )}
          <hr />
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            disabled={!project}
            onClick={() =>
              choose(() => {
                if (project) vm.openProjectPage(project, 'files');
              })
            }
          >
            <FileCode2 size={15} aria-hidden="true" />
            <span>{t('pages.files')}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            disabled={!project}
            onClick={() =>
              choose(() => {
                if (project) vm.openProjectPage(project, 'changes');
              })
            }
          >
            <GitCompareArrows size={15} aria-hidden="true" />
            <span>{t('pages.changes')}</span>
          </button>
          <hr />
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            disabled={sessionDisabled}
            onClick={() => choose(() => vm.newSession(project))}
          >
            <Plus size={15} aria-hidden="true" />
            <span>{t('topbar.newSession')}</span>
            <kbd>Ctrl N</kbd>
          </button>
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            disabled={sessionDisabled}
            onClick={() => choose(() => vm.newSession(project, 'terminal'))}
          >
            <Terminal size={15} aria-hidden="true" />
            <span>{t('paletteActions.newTerminal')}</span>
          </button>
        </div>
      )}
    </div>
  );
}
