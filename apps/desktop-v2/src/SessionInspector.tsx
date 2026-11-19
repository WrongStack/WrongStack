import { Info, ListTodo, PanelRightClose, PanelRightOpen, Users } from 'lucide-react';
import { type KeyboardEvent, useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SessionAgentRail } from './AgentTranscripts';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand } from './engine-operations';
import type { EngineState } from './engine-state';
import { native, scanOrphanEngines } from './platform';
import { SessionTodos } from './SessionTodos';
import { SessionToolSummary } from './SessionToolSummary';
import { surfaceI18n } from './surface-i18n';
import './session-inspector.css';

const tabs = [
  { id: 'agents', Icon: Users },
  { id: 'plan', Icon: ListTodo },
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
  showThinkingLogs = true,
}: {
  state: EngineState;
  command: EngineCommand;
  onLink: (href: string) => void;
  showThinkingLogs?: boolean;
}) {
  const { t: words } = useTranslation('sessionInspector', { i18n: surfaceI18n });
  const id = useId();
  const [tab, setTab] = useState<InspectorTab>('agents');
  const [collapsed, setCollapsed] = useState(false);
  /** The icon rail lives at the screen edge, so choosing a section also opens the sidebar. */
  const open = (value: InspectorTab) => {
    setTab(value);
    setCollapsed(false);
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
    open(target.id);
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  };
  return (
    <>
      <aside className="session-inspector" data-collapsed={collapsed} aria-label={words('title')}>
        <header className="session-inspector-heading" hidden={collapsed}>
          <h2>{words(tab)}</h2>
        </header>
        <div id={`${id}-body`} className="session-inspector-body" hidden={collapsed}>
          {tabs.map(({ id: value }) => (
            <div
              key={value}
              id={`${id}-${value}-panel`}
              role="tabpanel"
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
      <div className="session-inspector-rail">
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
              onClick={() => open(value)}
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
          onClick={() => setCollapsed(!collapsed)}
        >
          {collapsed ? (
            <PanelRightOpen size={16} aria-hidden="true" />
          ) : (
            <PanelRightClose size={16} aria-hidden="true" />
          )}
        </button>
      </div>
    </>
  );
}
