import { Info, ListTodo, PanelRightClose, PanelRightOpen, Users } from 'lucide-react';
import { type KeyboardEvent, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SessionAgentRail } from './AgentTranscripts';
import type { EngineCommand } from './engine-operations';
import type { EngineState } from './engine-state';
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
  const navigate = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = tabs.findIndex((item) => item.id === tab);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? tabs.length - 1
          : event.key === 'ArrowRight'
            ? (index + 1) % tabs.length
            : event.key === 'ArrowLeft'
              ? (index + tabs.length - 1) % tabs.length
              : -1;
    const target = tabs[next];
    if (!target) return;
    event.preventDefault();
    setTab(target.id);
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  };
  return (
    <aside className="session-inspector" data-collapsed={collapsed} aria-label={words('title')}>
      <header className="session-inspector-heading">
        <h2 hidden={collapsed}>{words('title')}</h2>
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
          {collapsed && <span>{words('title')}</span>}
        </button>
      </header>
      <div id={`${id}-body`} className="session-inspector-body" hidden={collapsed}>
        <div
          className="session-inspector-tabs"
          role="tablist"
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
              tabIndex={tab === value ? 0 : -1}
              onClick={() => setTab(value)}
            >
              <Icon size={14} aria-hidden="true" />
              {words(value)}
            </button>
          ))}
        </div>
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
                </dl>
              </div>
            )}
          </div>
        ))}
      </div>
    </aside>
  );
}
