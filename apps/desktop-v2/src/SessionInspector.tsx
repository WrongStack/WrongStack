import { Bot, Info, ListTodo, PanelRightClose, PanelRightOpen, Users } from 'lucide-react';
import { type KeyboardEvent, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SessionAgentRail } from './AgentTranscripts';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand } from './engine-operations';
import type { EngineState } from './engine-state';
import { PaneSplitter } from './PaneSplitter';
import { paneBounds } from './pane-layout';
import { usePaneLayout } from './pane-layout-context';
import { native, scanOrphanEngines } from './platform';
import { SessionCompanions } from './SessionCompanions';
import { SessionTodos } from './SessionTodos';
import { SessionToolSummary } from './SessionToolSummary';
import { surfaceI18n } from './surface-i18n';
import './session-inspector.css';

const tabs = [
  { id: 'agents', Icon: Users },
  { id: 'plan', Icon: ListTodo },
  { id: 'companions', Icon: Bot },
  { id: 'details', Icon: Info },
] as const;
type InspectorTab = (typeof tabs)[number]['id'];

function BackgroundEnginePids() {
  const { t } = useDesktopText();
  const [scan, setScan] = useState(0);
  const [result, setResult] = useState<{
    scan: number;
    pids: number[] | null | 'error';
  }>();
  useEffect(() => {
    let current = true;
    void scanOrphanEngines().then(
      (rows) => {
        if (current) setResult({ scan, pids: rows?.map(({ pid }) => pid) ?? null });
      },
      () => {
        if (current) setResult({ scan, pids: 'error' });
      },
    );
    return () => {
      current = false;
    };
  }, [scan]);

  const pids = result?.scan === scan ? result.pids : undefined;
  if (pids === null) return null;
  return (
    <div>
      <dt>
        {t('engineCleanup.detailsTitle', { defaultValue: 'Orphaned engine PIDs (desktop-wide)' })}
      </dt>
      <dd>
        <span role="status">
          {pids === undefined ? (
            t('engineCleanup.working', { defaultValue: 'Checking engine processes…' })
          ) : pids === 'error' ? (
            t('engineCleanup.detailsError', {
              defaultValue: 'Could not scan for orphaned engines.',
            })
          ) : pids.length ? (
            <code>{pids.join(', ')}</code>
          ) : (
            t('engineCleanup.empty', { defaultValue: 'No confirmed orphaned engines found.' })
          )}
        </span>
      </dd>
      <dd>
        <button
          type="button"
          className="button secondary small"
          aria-disabled={pids === undefined}
          onClick={() => {
            if (pids !== undefined) setScan(scan + 1);
          }}
        >
          {t('engineCleanup.refreshPids', { defaultValue: 'Refresh PIDs' })}
        </button>
      </dd>
    </div>
  );
}

/** Inspection is independent of the leader transcript and never retargets its composer. */
export function SessionInspector({
  state,
  command,
  onLink,
  projectId = '',
  showThinkingLogs = true,
}: {
  projectId?: string;
  state: EngineState;
  command: EngineCommand;
  onLink: (href: string) => void;
  showThinkingLogs?: boolean;
}) {
  const { t: words } = useTranslation('sessionInspector', { i18n: surfaceI18n });
  const id = useId();
  const [tab, setTab] = useState<InspectorTab>('agents');
  const [localCollapsed, setLocalCollapsed] = useState(false);
  const [compact, setCompact] = useState(false);
  const [compactOpen, setCompactOpen] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const rail = useRef<HTMLDivElement>(null);
  const compactOpener = useRef<HTMLElement>(null);
  const paneLayout = usePaneLayout();
  const inspector = paneLayout?.panes.inspector;
  // Read the container query's mode rather than using the window width. The
  // explorer can make the conversation compact without resizing the window.
  useLayoutEffect(() => {
    const panes = panel.current?.parentElement;
    const layout = panes?.closest('.session-conversation-layout');
    if (!panes || !layout) return;
    let previous: boolean | undefined;
    const update = () => {
      if (!layout.clientWidth) return;
      const overlay =
        getComputedStyle(panes).getPropertyValue('--session-inspector-placement').trim() ===
        'overlay';
      if (overlay === previous) return;
      previous = overlay;
      if (overlay && panel.current?.contains(document.activeElement)) {
        rail.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
      }
      setCompact(overlay);
      if (!overlay) setCompactOpen(false);
    };
    update();
    if (typeof ResizeObserver === 'undefined') return;
    let frame: number | undefined;
    const observer = new ResizeObserver(() => {
      if (frame !== undefined) return;
      frame = requestAnimationFrame(() => {
        frame = undefined;
        update();
      });
    });
    observer.observe(layout);
    return () => {
      observer.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, []);

  useEffect(() => {
    if (!compact || !compactOpen) return;
    const contains = (target: EventTarget | null) =>
      target instanceof Node && (panel.current?.contains(target) || rail.current?.contains(target));
    const dismiss = (event: PointerEvent) => {
      if (!contains(event.target)) setCompactOpen(false);
    };
    const dismissOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || !contains(event.target)) return;
      event.preventDefault();
      setCompactOpen(false);
      compactOpener.current?.focus();
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', dismissOnEscape);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', dismissOnEscape);
    };
  }, [compact, compactOpen]);

  const collapsed = compact ? !compactOpen : inspector ? !inspector.open : localCollapsed;
  const setCollapsed = (value: boolean, opener?: HTMLElement) => {
    if (compact) {
      if (opener && !value) compactOpener.current = opener;
      setCompactOpen(!value);
    } else if (paneLayout && inspector) {
      paneLayout.setOpen('inspector', !value);
    } else {
      setLocalCollapsed(value);
    }
  };
  const pane =
    !compact && paneLayout && inspector?.open
      ? {
          width: inspector.width,
          setWidth: (width: number) => paneLayout.setWidth('inspector', width),
        }
      : undefined;
  /** The icon rail lives at the screen edge, so choosing a section also opens the sidebar. */
  const open = (value: InspectorTab, opener?: HTMLElement) => {
    setTab(value);
    setCollapsed(false, opener);
  };
  const navigate = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = tabs.findIndex((item) => item.id === tab);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? tabs.length - 1
          : event.key === 'ArrowDown' || event.key === 'ArrowRight'
            ? (index + 1) % tabs.length
            : event.key === 'ArrowUp' || event.key === 'ArrowLeft'
              ? (index + tabs.length - 1) % tabs.length
              : -1;
    const target = tabs[next];
    if (!target) return;
    event.preventDefault();
    const button = event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next];
    open(target.id, button);
    button?.focus();
  };
  return (
    <>
      <div className="session-inspector-rail" ref={rail}>
        <div
          className="session-inspector-rail-tabs"
          role="tablist"
          aria-orientation="vertical"
          aria-label={words('title')}
          onKeyDown={navigate}
        >
          {tabs.map(({ id: value, Icon }) => (
            <button
              key={value}
              id={`${id}-${value}-tab`}
              type="button"
              role="tab"
              aria-selected={tab === value}
              aria-controls={`${id}-${value}-panel`}
              title={words(value)}
              tabIndex={tab === value ? 0 : -1}
              onClick={(event) => open(value, event.currentTarget)}
            >
              <Icon size={16} aria-hidden="true" />
              <span className="session-inspector-rail-label">{words(value)}</span>
            </button>
          ))}
        </div>
        <button
          type="button"
          className="session-inspector-toggle"
          aria-label={words(collapsed ? 'expand' : 'collapse')}
          title={words(collapsed ? 'expand' : 'collapse')}
          aria-expanded={!collapsed}
          aria-controls={`${id}-body`}
          onClick={(event) => setCollapsed(!collapsed, event.currentTarget)}
        >
          {collapsed ? (
            <PanelRightOpen size={16} aria-hidden="true" />
          ) : (
            <PanelRightClose size={16} aria-hidden="true" />
          )}
        </button>
      </div>
      <aside
        ref={panel}
        className="session-inspector"
        data-collapsed={collapsed}
        data-pane-width={pane ? pane.width : undefined}
        style={pane ? { ['--session-inspector-width' as string]: `${pane.width}px` } : undefined}
        aria-label={words('title')}
      >
        {pane && (
          <PaneSplitter
            label={words('title')}
            controls={`${id}-body`}
            side="right"
            width={pane.width}
            min={paneBounds.inspector.min}
            max={paneBounds.inspector.max}
            onResize={pane.setWidth}
          />
        )}
        <header className="session-inspector-heading" hidden={collapsed}>
          <h2>{words(tab)}</h2>
        </header>
        <div id={`${id}-body`} className="session-inspector-body" hidden={collapsed}>
          {tabs.map(({ id: value }) => (
            <div
              key={value}
              id={`${id}-${value}-panel`}
              role="tabpanel"
              tabIndex={compact ? 0 : undefined}
              aria-labelledby={`${id}-${value}-tab`}
              hidden={tab !== value}
              className={`session-inspector-panel inspector-${value}`}
            >
              {value === 'agents' ? (
                <SessionAgentRail
                  state={state}
                  onLink={onLink}
                  showThinkingLogs={showThinkingLogs}
                  embedded
                />
              ) : value === 'plan' ? (
                <SessionTodos state={state} command={command} embedded />
              ) : value === 'companions' ? (
                tab === 'companions' &&
                !collapsed && (
                  <SessionCompanions
                    key={projectId}
                    projectId={projectId}
                    connected={state.connected}
                    command={command}
                  />
                )
              ) : (
                <div className="session-inspector-details">
                  <SessionToolSummary activity={state} />
                  <p>{words('detailsHint')}</p>
                  <dl>
                    <div>
                      <dt>{words('session')}</dt>
                      <dd>{state.sessionId || '—'}</dd>
                    </div>
                    <div>
                      <dt>{words('provider')}</dt>
                      <dd>{state.provider || '—'}</dd>
                    </div>
                    <div>
                      <dt>{words('model')}</dt>
                      <dd>{state.model || '—'}</dd>
                    </div>
                    <div>
                      <dt>{words('connection')}</dt>
                      <dd>{words(state.connected ? 'connected' : 'offline')}</dd>
                    </div>
                    {native && tab === 'details' && !collapsed && <BackgroundEnginePids />}
                  </dl>
                </div>
              )}
            </div>
          ))}
        </div>
      </aside>
    </>
  );
}
