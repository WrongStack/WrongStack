import type { QuotaSnapshot } from '@wrongstack/project-surfaces/providers/provider-quota-store';
import { Bot, Check, ChevronDown, KeyRound, LoaderCircle, Search, TimerOff } from 'lucide-react';
import {
  type CSSProperties,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useDesktopText } from './desktop-i18n';
import { displayLocale } from './display-dates';
import type { EngineCommand } from './engine-operations';
import { type EngineState, emptyEngineState } from './engine-state';
import { entries } from './engine-values';
import { compactCount, type PickerModel, pickerModel } from './model-picker-details';
import { RECENT_MODELS_KEY, readRecentModels, withRecentModel } from './model-recents';
import { type SwitcherRow, type SwitcherStatus, switcherRows } from './model-switcher-model';
import { selectableCatalogModels } from './model-visibility';
import { emptyModelPolicy, readProfileModelPolicy } from './profile-model-policy';
import { providerChoices } from './provider-settings-model';
import { RuntimeGate } from './RuntimeGate';
import { useProfileEngine } from './useEngine';
import './model-switcher.css';

interface Props {
  session: EngineState;
  sessionCommand: EngineCommand;
  onClose: () => void;
  /** The full picker: search, comparison, favourites and every provider's catalog. */
  onAllModels: () => void;
  onSettings: () => void;
  onBusy: (busy: boolean) => void;
}

/**
 * The composer's model switcher: one row per usable provider and per ACP agent, the model it
 * would run, and the fact that decides the pick (quota left, a reached limit, a missing key).
 */
export function ModelQuickSwitcher(props: Props) {
  return (
    <RuntimeGate scope="profile">
      <LiveSwitcher {...props} />
    </RuntimeGate>
  );
}

/** A provider's monogram hue, the same for the same name everywhere. */
function markHue(name: string): number {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) % 360;
  return hash;
}

function LiveSwitcher({
  session,
  sessionCommand,
  onClose,
  onAllModels,
  onSettings,
  onBusy,
}: Props) {
  const { t } = useDesktopText();
  const [error, setError] = useState('');
  const report = useCallback(
    (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)),
    [],
  );
  const profile = useProfileEngine(report);
  const [rows, setRows] = useState<SwitcherRow[] | null>(null),
    [policy, setPolicy] = useState<Record<string, unknown>>(emptyModelPolicy),
    [expanded, setExpanded] = useState(''),
    [models, setModels] = useState<Record<string, PickerModel[] | 'loading'>>({}),
    [switching, setSwitching] = useState('');
  const list = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  const recents = () => readRecentModels(() => localStorage.getItem(RECENT_MODELS_KEY));
  const load = useCallback(async () => {
    try {
      const [prefs, saved, catalog] = await Promise.all([
        readProfileModelPolicy(profile.command),
        profile.command('providers.saved', {}, ['providers.saved']),
        profile.command('providers.list', {}, ['provider.catalog']),
      ]);
      const choices = providerChoices({
        ...emptyEngineState,
        results: { 'providers.saved': saved, 'provider.catalog': catalog },
      });
      // Quota and the ACP agents only add detail: a failed read leaves rows without it.
      const [quota, agents] = await Promise.all([
        profile
          .command('provider.quota.get', {}, ['provider.quota'])
          .then((reply) => entries(reply['snapshots']) as unknown as QuotaSnapshot[])
          .catch(() => []),
        choices.some((choice) => choice.id === 'acp')
          ? profile
              .command('provider.models', { providerId: 'acp' }, ['provider.models'])
              .then((reply) =>
                selectableCatalogModels(entries(reply['models']).map(pickerModel), 'acp', prefs),
              )
              .then((found) => found.map((model) => model.id))
              .catch(() => [])
          : Promise.resolve([] as string[]),
      ]);
      if (!mounted.current) return;
      setPolicy(prefs);
      setRows(
        switcherRows({
          choices,
          session: { provider: session.provider, model: session.model },
          recents: recents(),
          acpAgents: agents,
          quota,
          policy: prefs,
        }),
      );
    } catch (cause) {
      if (mounted.current) report(cause);
    }
  }, [profile.command, session.provider, session.model, report]);
  useEffect(() => {
    if (profile.state.connected && !profile.state.hydrating) void load();
  }, [profile.state.connected, profile.state.hydrating, load]);
  // Focus the current row once the rows arrive, so the keyboard starts where the session is.
  useEffect(() => {
    if (rows) list.current?.querySelector<HTMLButtonElement>('.model-switcher-pick')?.focus();
  }, [rows]);

  const expand = async (provider: string) => {
    if (expanded === provider) return setExpanded('');
    setExpanded(provider);
    if (models[provider]) return;
    setModels((current) => ({ ...current, [provider]: 'loading' }));
    try {
      const reply = await profile.command(
        'provider.models',
        { providerId: provider, includeDisabled: true },
        ['provider.models'],
      );
      const found = selectableCatalogModels(
        entries(reply['models']).map(pickerModel),
        provider,
        policy,
      );
      if (mounted.current) setModels((current) => ({ ...current, [provider]: found }));
    } catch (cause) {
      if (!mounted.current) return;
      setModels((current) => ({ ...current, [provider]: [] }));
      report(cause);
    }
  };
  const choose = async (provider: string, model: string) => {
    if (switching) return;
    setSwitching(`${provider}/${model}`);
    onBusy(true);
    setError('');
    try {
      // The profile may have hidden the model since the rows were read.
      const current = await readProfileModelPolicy(profile.command);
      if (!selectableCatalogModels([{ id: model }], provider, current).length)
        throw Error(t('modelPicker.disabled'));
      if (provider !== session.provider || model !== session.model)
        await sessionCommand('model.switch', { provider, model }, ['model.switch_result']);
      try {
        localStorage.setItem(
          RECENT_MODELS_KEY,
          JSON.stringify(withRecentModel(recents(), { provider, model })),
        );
      } catch {
        // Recents are a convenience; a full or blocked store leaves them unsaved.
      }
      if (mounted.current) onClose();
    } catch (cause) {
      if (mounted.current) report(cause);
    } finally {
      onBusy(false);
      if (mounted.current) setSwitching('');
    }
  };
  const pick = (row: SwitcherRow) => {
    if (row.status.kind === 'needs-key') return onSettings();
    if (row.model) return void choose(row.provider, row.model);
    void expand(row.provider);
  };
  /** Up and down move between rows and the models open under one, as a menu does. */
  const navigate = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const targets = Array.from(
      list.current?.querySelectorAll<HTMLButtonElement>(
        '.model-switcher-pick:not(:disabled), .model-switcher-model:not(:disabled)',
      ) ?? [],
    );
    const index = targets.indexOf(document.activeElement as HTMLButtonElement);
    const next = targets[event.key === 'ArrowDown' ? index + 1 : Math.max(0, index - 1)];
    if (!next) return;
    event.preventDefault();
    next.focus();
  };

  return (
    <div className="model-switcher-body">
      {error && (
        <p className="composer-error" role="alert">
          {error}
        </p>
      )}
      {!rows ? (
        <p className="model-switcher-empty" role="status">
          <LoaderCircle size={14} className="spin" /> {t('modelPicker.loading')}
        </p>
      ) : (
        // biome-ignore lint/a11y/noStaticElementInteractions: arrow keys move between the buttons inside.
        <div className="model-switcher-rows" ref={list} onKeyDown={navigate}>
          {rows.map((row, index) => {
            const open = expanded === row.provider && !row.agent;
            const found = models[row.provider];
            // A group heading where providers give way to agents or the other way round.
            const heading = index === 0 || rows[index - 1]?.agent !== row.agent;
            return (
              <div key={row.key} className="model-switcher-group">
                {heading && (
                  <p className="model-switcher-heading">
                    {row.agent ? t('switcher.agents') : t('switcher.providers')}
                  </p>
                )}
                <div
                  className={`model-switcher-row${row.current ? ' is-current' : ''}`}
                  data-status={row.status.kind}
                >
                  <div className="model-switcher-line">
                    <button
                      type="button"
                      className="model-switcher-pick"
                      aria-current={row.current ? 'true' : undefined}
                      disabled={switching !== ''}
                      onClick={() => pick(row)}
                    >
                      <span
                        className="model-switcher-mark"
                        style={{ '--mark-hue': markHue(row.name) } as CSSProperties}
                        aria-hidden="true"
                      >
                        {row.name.slice(0, 1).toUpperCase()}
                        {row.agent && <Bot size={10} className="model-switcher-agent" />}
                      </span>
                      <span className="model-switcher-copy">
                        <strong>{row.name}</strong>
                        {row.subtitle && <small>{row.subtitle}</small>}
                      </span>
                      <StatusNote status={row.status} />
                      {row.current && (
                        <Check size={15} className="model-switcher-check" aria-hidden="true" />
                      )}
                      {switching.startsWith(`${row.provider}/`) && (
                        <LoaderCircle size={14} className="spin" aria-hidden="true" />
                      )}
                    </button>
                    {!row.agent && (
                      <button
                        type="button"
                        className="model-switcher-expand icon-button"
                        aria-expanded={open}
                        aria-label={t('switcher.models', { name: row.name })}
                        title={t('switcher.models', { name: row.name })}
                        onClick={() => void expand(row.provider)}
                      >
                        <ChevronDown size={14} aria-hidden="true" />
                      </button>
                    )}
                  </div>
                  {open && (
                    <div className="model-switcher-models">
                      {found === 'loading' || !found ? (
                        <p className="model-switcher-empty" role="status">
                          <LoaderCircle size={13} className="spin" /> {t('modelPicker.loading')}
                        </p>
                      ) : found.length ? (
                        found.map((model) => {
                          const chosen =
                            row.provider === session.provider && model.id === session.model;
                          return (
                            <button
                              type="button"
                              key={model.id}
                              className="model-switcher-model"
                              aria-current={chosen ? 'true' : undefined}
                              disabled={switching !== ''}
                              onClick={() => void choose(row.provider, model.id)}
                            >
                              <span className="model-switcher-model-name">{model.name}</span>
                              {model.contextWindow ? (
                                <small>{compactCount(model.contextWindow)}</small>
                              ) : null}
                              {chosen && <Check size={13} aria-hidden="true" />}
                            </button>
                          );
                        })
                      ) : (
                        <p className="model-switcher-empty">{t('switcher.noModels')}</p>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      <div className="model-switcher-footer">
        <button type="button" className="model-switcher-all" onClick={onAllModels}>
          <Search size={13} aria-hidden="true" /> {t('switcher.all')}
        </button>
      </div>
    </div>
  );
}

/** The row's deciding fact: quota left as a bar, a reached limit with its reset, or a missing key. */
function StatusNote({ status }: { status: SwitcherStatus }) {
  const { t } = useDesktopText();
  if (status.kind === 'needs-key')
    return (
      <span className="model-switcher-status is-key">
        <KeyRound size={12} aria-hidden="true" /> {t('switcher.needsKey')}
      </span>
    );
  if (status.kind === 'reached') {
    const time = status.resetsAt
      ? new Date(status.resetsAt * 1000).toLocaleTimeString(displayLocale(), {
          hour: '2-digit',
          minute: '2-digit',
        })
      : '';
    return (
      <span className="model-switcher-status is-reached">
        <TimerOff size={12} aria-hidden="true" />{' '}
        {time ? t('switcher.reachedAt', { time }) : t('switcher.reached')}
      </span>
    );
  }
  if (status.kind === 'quota')
    return (
      <span className={`model-switcher-status is-quota level-${status.level}`}>
        <span>{t('switcher.left', { window: status.window, percent: status.left })}</span>
        <span className="model-switcher-quota" aria-hidden="true">
          <span style={{ inlineSize: `${status.left}%` }} />
        </span>
      </span>
    );
  return null;
}
