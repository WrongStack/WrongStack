import {
  ArrowLeft,
  BookOpen,
  Bot,
  Brain,
  CalendarDays,
  Check,
  Coins,
  FlaskConical,
  Gauge,
  KeyRound,
  Layers3,
  ListChecks,
  Plug,
  Route,
  Save,
  Search,
  Send,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  SquareTerminal,
  Stethoscope,
  Wrench,
} from 'lucide-react';
import { Fragment, useEffect, useState } from 'react';
import { AvailabilitySettings } from './AvailabilitySettings';
import { availabilityIssue } from './availability-model';
import { availabilityWords } from './availability-words';
import { BrainPolicySettings } from './BrainPolicySettings';
import { ExecutionPolicySettings } from './ExecutionPolicySettings';
import { prepareExecutionPolicyPatch } from './execution-policy-model';
import { FleetPolicySettings } from './FleetPolicySettings';
import { fleetPolicyIssue } from './fleet-policy-model';
import { IntegrationSettings } from './IntegrationSettings';
import { PluginToggles } from './PluginToggles';
import { RefinementPolicySettings } from './RefinementPolicySettings';
import { prepareRefinementPolicyPatch } from './refinement-policy-model';
import { SettingsSectionSelect } from './SettingsSectionSelect';
import { ToolAccessSettings } from './ToolAccessSettings';
import { type InstructionDraft, UserInstructionsSettings } from './UserInstructionsSettings';
import './settings-management.css';
import { FallbackPolicySettings, RoutingPolicySettings } from './ModelPolicySettings';
import { LimitsPolicySettings, TierPolicySettings } from './ResourcePolicySettings';
import { prepareSettingsPatch, sameSetting } from './settings-save-model';
import './settings-policy.css';
import { BackgroundServices } from './BackgroundServices';
import { BrainDecisions } from './BrainDecisions';
import { BrowserNetworkPolicy } from './BrowserNetworkPolicy';
import { ConfigDoctor } from './ConfigDoctor';
import { JevSettings } from './JevSettings';
import { ModelCatalogSettings } from './ModelCatalogSettings';
import { ModelVisibilitySettings } from './ModelVisibilitySettings';
import { ProviderDiagnostics } from './ProviderDiagnostics';
import { ProviderHealth } from './ProviderHealth';
import { ProviderSettings } from './ProviderSettings';
import { ProviderSurfaces } from './ProviderSurfaces';
import { request } from './platform';
import { ReviewPolicySettings } from './ReviewPolicySettings';
import { RuntimeGate } from './RuntimeGate';
import { reviewPolicyIssue } from './review-policy-model';
import { SystemPromptPresets } from './SystemPromptPresets';
import './review-policy.css';
import { localizedText, useDesktopText } from './desktop-i18n';
import { SettingRow } from './SettingRow';
import { SkillLibrary } from './SkillLibrary';
import {
  changedSettings,
  type SettingField,
  settingChange,
  settingsSections,
  settingValue,
  writeOnlySettings,
} from './settings-fields';
import { useReportSettingsSection, useRequestedSettingsSection } from './settings-section-request';
import type { DesktopController } from './useDesktop';
import { useProfileEngine } from './useEngine';

/** The catalog key of each settings navigation group. */
const SETTINGS_GROUP_KEY = {
  Models: 'models',
  Conversations: 'conversations',
  'Agents & tools': 'agents',
  Diagnostics: 'diagnostics',
} as const;

export function WrongStackSettings({ vm }: { vm: DesktopController }) {
  return (
    <RuntimeGate scope="profile">
      <ProfileSettings vm={vm} />
    </RuntimeGate>
  );
}
function ProfileSettings({ vm }: { vm: DesktopController }) {
  const { state, send, command } = useProfileEngine(vm.reportError);
  const [search, setSearch] = useState('');
  const [loaded, setLoaded] = useState(false);
  const { t } = useDesktopText();
  const [modelsOpened, setModelsOpened] = useState(false);
  const [brainOpened, setBrainOpened] = useState(false);
  const [instructionDraft, setInstructionDraft] = useState<InstructionDraft>({
    document: null,
    text: '',
  });
  const [section, setSection] = useState(() => (state.needsSetup ? 'setup' : 'providers')),
    [base, setBase] = useState<Record<string, unknown>>({}),
    [draft, setDraft] = useState<Record<string, unknown>>({}),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  useRequestedSettingsSection((wanted) => {
    if (wanted === 'brain') setBrainOpened(true);
    setSection(wanted);
  });
  useReportSettingsSection(section);
  useEffect(() => {
    if (!state.connected) return;
    let active = true;
    void command('prefs.get', {}, ['prefs.updated'])
      .then((prefs) => {
        if (active) {
          const { requestId: _requestId, sessionId: _sessionId, ...values } = prefs;
          setBase(values);
          setDraft(values);
          setLoaded(true);
        }
      })
      .catch((error: unknown) => {
        if (active) setError(String(error instanceof Error ? error.message : error));
      });
    return () => {
      active = false;
    };
  }, [state.connected, command]);
  const dirty = changedSettings(base, draft);
  const fields = settingsSections.find((item) => item.id === section);
  const advanced: Record<string, { title: string; description: string }> = {
    refinement: {
      title: 'Prompt refinement',
      description:
        'Refiner provider/model, named profile, language, review on submit and a saved-route sample preview.',
    },
    execution: {
      title: 'Execution & permissions',
      description:
        'Standard approvals, YOLO, YOLO+, destructive operation confirmations, disk wipe, publish, trusted state and credential binding.',
    },
    brain: {
      title: 'Brain policy',
      description:
        'Risk ceiling, escalation, decision cache, heuristics, model quality, monitor, stall, error storm, file churn, cooldown, council, ledger and replay trace path/capacity.',
    },
    fleet: {
      title: 'Fleet & companions',
      description:
        'Concurrent agents, Memory Companion, Explore Companion, Skill Companion and next-step guidance.',
    },
    'model-visibility': {
      title: 'Model visibility',
      description: 'Enabled models, favorites and reviewed cleanup of fallback references.',
    },
    reviews: {
      title: 'Review policy',
      description: 'Chimera and continuous review models, batches, follow-up and cascade policy.',
    },
    'model-routing': {
      title: 'Model routing',
      description: 'Model and reasoning overrides for each role or phase.',
    },
    'cost-tiers': {
      title: 'Cost tiers',
      description: 'Worker models, explicit budgets and tier switching rules.',
    },
    'resource-limits': {
      title: 'Resource limits',
      description: 'Optional context, output and worker budget overrides.',
    },
    availability: {
      title: 'Model availability',
      description: 'Provider and model time windows, weekdays, overnight schedules and timezones.',
    },
    instructions: {
      title: 'Global instructions',
      description: 'User rules and AGENTS.md across projects and profiles.',
    },
    'tool-access': {
      title: 'Tool availability',
      description: 'Registered tool catalog, permission metadata, enable and disable tools.',
    },
  };
  const heading = fields ?? advanced[section];
  // Registry sections and the hand-built ones name their words under different catalog keys.
  const headingText = heading && {
    title: t(fields ? `sectionInfo.${section}.title` : `settings.section.${section}`, {
      defaultValue: heading.title,
    }),
    description: t(fields ? `sectionInfo.${section}.description` : `advanced.${section}`, {
      defaultValue: heading.description,
    }),
  };
  const change = (key: string, value: unknown) => {
    setDraft((draft) => ({ ...draft, [key]: value }));
    setNotice('');
  };
  const save = async () => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const live = await command('prefs.get', {}, ['prefs.updated']);
      const executionPatch = prepareExecutionPolicyPatch(
        base,
        draft,
        live,
        prepareSettingsPatch(base, draft, live),
      );
      const patch = prepareRefinementPolicyPatch(base, draft, live, executionPatch);
      if (!Object.keys(patch).length) {
        const { requestId: _requestId, sessionId: _sessionId, ...values } = live;
        setBase(values);
        setDraft(values);
        setNotice('Profile settings already match saved values.');
        return;
      }
      const fleetIssue = fleetPolicyIssue(patch);
      if (fleetIssue) throw Error(fleetIssue);
      const reviewIssue = reviewPolicyIssue(patch);
      if (reviewIssue) throw Error(reviewIssue);
      if (Object.hasOwn(patch, 'modelAvailabilitySchedule')) {
        const issue = availabilityIssue(patch['modelAvailabilitySchedule'], availabilityWords(t));
        if (issue) throw Error(issue);
      }
      const profiles =
        draft['fallbackProfiles'] && typeof draft['fallbackProfiles'] === 'object'
          ? (draft['fallbackProfiles'] as Record<string, unknown>)
          : {};
      for (const [name, chain] of Object.entries({
        'Default fallback chain': draft['fallbackModels'],
        ...profiles,
      })) {
        if (
          Array.isArray(chain) &&
          chain.some((model) => typeof model !== 'string' || !model.trim())
        )
          throw Error(`Every model in “${name}” needs a non-empty reference.`);
      }
      await command('prefs.update', patch, ['key.operation_result']);
      const result = await command('prefs.get', {}, ['prefs.updated']);
      for (const [key, value] of Object.entries(patch)) {
        if (!writeOnlySettings.has(key) && !sameSetting(result[key], value))
          throw new Error('The saved settings could not be verified. Reload before retrying.');
      }
      const { requestId: _requestId, sessionId: _sessionId, ...values } = result;
      setBase(values);
      setDraft(values);
      setNotice('WrongStack settings saved to your active profile.');
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const configured = (provider: string, model: string) => {
    const session = vm.snapshot.sessions.find((session) => session.id === vm.settingsReturnSession);
    if (!session) return;
    void vm.run(async () => {
      await request('engine.send', {
        id: session.id,
        message: {
          type: 'model.switch',
          payload: { provider, model, requestId: crypto.randomUUID() },
        },
      });
      vm.setSettingsReturnSession(null);
      vm.jumpToSession(session);
    });
  };
  if (!state.connected)
    return (
      <div className="runtime-state">
        <h2>{t('settings.loading')}</h2>
      </div>
    );
  const openSection = (id: string) => {
    if (id === 'models') setModelsOpened(true);
    if (id === 'brain') setBrainOpened(true);
    setSection(id);
  };
  return (
    <section className="wrongstack-settings" aria-label={t('rail.settings')}>
      {/* The header row already names this page; only the way back gets a row of its own. */}
      {vm.settingsReturnSession && (
        <header className="wrongstack-settings-heading">
          <button
            type="button"
            className="button secondary"
            onClick={() => {
              const session = vm.snapshot.sessions.find(
                (session) => session.id === vm.settingsReturnSession,
              );
              vm.setSettingsReturnSession(null);
              if (session) vm.jumpToSession(session);
            }}
          >
            <ArrowLeft size={14} />
            {t('settings.back')}
          </button>
        </header>
      )}
      <div className="settings-workspace">
        <nav className="settings-navigation" aria-label={t('settings.sections')}>
          <label className="settings-search">
            <Search size={14} />
            <input
              aria-label={t('settings.search')}
              placeholder={t('settings.find')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          {(
            [
              { id: 'setup', title: 'Quick setup', Icon: Sparkles, group: 'Models' },
              { id: 'providers', title: 'Providers & models', Icon: KeyRound, group: 'Models' },
              { id: 'models', title: 'Model catalog', Icon: Layers3, group: 'Models' },
              { id: 'model-visibility', title: 'Model visibility', Icon: Layers3, group: 'Models' },
              {
                id: 'availability',
                title: 'Model availability',
                Icon: CalendarDays,
                group: 'Models',
              },
              { id: 'routing', title: 'Fallbacks & agent defaults', Icon: Bot, group: 'Models' },
              { id: 'model-routing', title: 'Model routing', Icon: Route, group: 'Models' },
              { id: 'cost-tiers', title: 'Cost tiers', Icon: Coins, group: 'Models' },
              {
                id: 'execution',
                title: 'Execution & permissions',
                Icon: ShieldCheck,
                group: 'Conversations',
              },
              {
                id: 'refinement',
                title: 'Prompt refinement',
                Icon: Sparkles,
                group: 'Conversations',
              },
              { id: 'context', title: 'Context & reasoning', Icon: Brain, group: 'Conversations' },
              {
                id: 'instructions',
                title: 'Global instructions',
                Icon: BookOpen,
                group: 'Conversations',
              },
              {
                id: 'resource-limits',
                title: 'Resource limits',
                Icon: SlidersHorizontal,
                group: 'Conversations',
              },
              { id: 'reviews', title: 'Review policy', Icon: ShieldCheck, group: 'Conversations' },
              { id: 'capabilities', title: 'Capabilities', Icon: Layers3, group: 'Agents & tools' },
              {
                id: 'tool-access',
                title: 'Tool availability',
                Icon: Wrench,
                group: 'Agents & tools',
              },
              { id: 'fleet', title: 'Fleet & companions', Icon: Layers3, group: 'Agents & tools' },
              { id: 'brain', title: 'Brain policy', Icon: Brain, group: 'Agents & tools' },
              { id: 'skills', title: 'Profile skills', Icon: BookOpen, group: 'Agents & tools' },
              { id: 'integrations', title: 'Connected tools', Icon: Plug, group: 'Agents & tools' },
              {
                id: 'notifications',
                title: 'HQ, proxy & Telegram',
                Icon: Send,
                group: 'Agents & tools',
              },
              {
                id: 'health',
                title: 'Provider diagnostics',
                Icon: Stethoscope,
                group: 'Diagnostics',
              },
              { id: 'quota', title: 'Plan quota', Icon: Gauge, group: 'Diagnostics' },
              { id: 'model-tests', title: 'Model tests', Icon: FlaskConical, group: 'Diagnostics' },
              {
                id: 'terminal-display',
                title: 'Terminal display',
                Icon: SquareTerminal,
                group: 'Diagnostics',
              },
              {
                id: 'logging',
                title: 'Logs & diagnostics',
                Icon: ListChecks,
                group: 'Diagnostics',
              },
            ] as const
          )
            .map((item) => ({
              ...item,
              english: item.title,
              title: t(`settings.section.${item.id}`),
              group: t(`settings.groups.${SETTINGS_GROUP_KEY[item.group]}`),
            }))
            .filter(
              (item) =>
                !search.trim() ||
                (
                  item.title +
                  ' ' +
                  item.english +
                  ' ' +
                  (settingsSections
                    .find((s) => s.id === item.id)
                    ?.fields.map(
                      (f) =>
                        `${f.label} ${f.description} ${t(`fields.${f.key}.label`, { defaultValue: '' })} ${t(`fields.${f.key}.description`, { defaultValue: '' })}`,
                    )
                    .join(' ') ?? '') +
                  ' ' +
                  (advanced[item.id]?.description ?? '')
                )
                  .toLowerCase()
                  .includes(search.toLowerCase()),
            )
            .map(({ id, title, Icon, group }, index, shown) => (
              <Fragment key={id}>
                {index === 0 && (
                  <SettingsSectionSelect
                    sections={shown}
                    section={section}
                    onSelect={openSection}
                  />
                )}
                {shown[index - 1]?.group !== group && (
                  <small className="settings-nav-group">{group}</small>
                )}
                <button
                  type="button"
                  aria-current={section === id ? 'page' : undefined}
                  onClick={() => openSection(id)}
                >
                  <Icon size={16} />
                  <span>{title}</span>
                </button>
              </Fragment>
            ))}
        </nav>
        <div className="settings-detail">
          {error && (
            <div className="session-error" role="alert">
              {localizedText(error, 'settingsMessage', t)}
              <button
                type="button"
                className="button secondary small"
                disabled={busy}
                onClick={() => {
                  setLoaded(false);
                  void command('prefs.get', {}, ['prefs.updated'])
                    .then((values) => {
                      const { requestId: _, sessionId: __, ...saved } = values;
                      setBase(saved);
                      setDraft(saved);
                      setError('');
                    })
                    .catch((e) => setError(String(e)))
                    .finally(() => setLoaded(true));
                }}
              >
                {t('settings.saveBar.reloadSaved')}
              </button>
            </div>
          )}
          {notice && (
            <div className="studio-notice" role="status">
              <Check size={13} />
              {notice}
            </div>
          )}
          {loaded && modelsOpened && (
            <div hidden={section !== 'models'}>
              <ModelCatalogSettings command={command} />
            </div>
          )}
          {loaded && brainOpened && (
            <div hidden={section !== 'brain'}>
              <BrainPolicySettings command={command} />
              <BrainDecisions command={command} />
              <JevSettings command={command} />
            </div>
          )}
          {!loaded ? (
            <p className="quiet-state">Loading saved profile settings…</p>
          ) : section === 'providers' ? (
            <ProviderSettings
              state={state}
              send={send}
              command={command}
              onError={vm.reportError}
              onConfigured={configured}
            />
          ) : section === 'models' || section === 'brain' ? null : section === 'skills' ? (
            <SkillLibrary command={command} scope="profile" />
          ) : section === 'integrations' ? (
            <IntegrationSettings
              command={command}
              capabilities={
                Array.isArray(state.results['session.start']?.['protocolCapabilities'])
                  ? (state.results['session.start']['protocolCapabilities'] as unknown[])
                  : []
              }
            />
          ) : section === 'setup' || section === 'quota' || section === 'model-tests' ? (
            <ProviderSurfaces
              page={section === 'model-tests' ? 'tests' : section === 'quota' ? 'quota' : 'setup'}
              state={state}
              command={command}
              onConfigured={configured}
              updatePrefs={(patch) =>
                void command('prefs.update', { ...patch }, ['key.operation_result']).catch(
                  vm.reportError,
                )
              }
            />
          ) : section === 'health' ? (
            <>
              <ProviderHealth state={state} command={command} />
              <ProviderDiagnostics state={state} send={send} />
              <BackgroundServices command={command} />
              <ConfigDoctor
                command={command}
                onApplied={() =>
                  setNotice(
                    'The profile configuration was repaired. Open settings forms still show the values read before; reload them before saving.',
                  )
                }
              />
            </>
          ) : section === 'instructions' ? (
            <>
              <UserInstructionsSettings
                command={command}
                value={instructionDraft}
                onChange={setInstructionDraft}
              />
              <SystemPromptPresets command={command} />
            </>
          ) : section === 'tool-access' ? (
            <>
              <ToolAccessSettings command={command} />
              <BrowserNetworkPolicy command={command} />
            </>
          ) : heading ? (
            <>
              <header className="settings-section-heading">
                <div>
                  <h2>{headingText?.title}</h2>
                  <p>{headingText?.description}</p>
                </div>
              </header>
              <div className="settings-defaults-note">
                Changes are saved as profile defaults. Existing runs keep their current options.
              </div>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void save();
                }}
              >
                <fieldset className="settings-form-fields" disabled={busy}>
                  {(fields?.fields as readonly SettingField[] | undefined)
                    ?.filter((field) => !field.when || settingValue(draft, field.when) === true)
                    .map((field) => (
                      <SettingRow
                        key={field.key}
                        field={field}
                        value={settingValue(draft, field.key)}
                        onChange={(value) => change(...settingChange(draft, field.key, value))}
                      />
                    ))}
                  {section === 'routing' && (
                    <FallbackPolicySettings draft={draft} change={change} command={command} />
                  )}
                  {section === 'capabilities' && <PluginToggles draft={draft} change={change} />}
                  {section === 'refinement' && (
                    <RefinementPolicySettings
                      draft={draft}
                      saved={base}
                      change={change}
                      command={command}
                    />
                  )}
                  {section === 'execution' && (
                    <ExecutionPolicySettings draft={draft} change={change} />
                  )}
                  {section === 'fleet' && <FleetPolicySettings draft={draft} change={change} />}
                  {section === 'model-routing' && (
                    <RoutingPolicySettings draft={draft} change={change} command={command} />
                  )}
                  {section === 'cost-tiers' && (
                    <TierPolicySettings draft={draft} change={change} command={command} />
                  )}
                  {section === 'resource-limits' && (
                    <LimitsPolicySettings draft={draft} change={change} />
                  )}
                  {section === 'reviews' && (
                    <ReviewPolicySettings
                      draft={draft}
                      saved={base}
                      change={change}
                      command={command}
                    />
                  )}
                  {section === 'availability' && (
                    <AvailabilitySettings draft={draft} change={change} command={command} />
                  )}
                  {section === 'model-visibility' && (
                    <ModelVisibilitySettings
                      draft={draft}
                      change={change}
                      command={command}
                      defaultProvider={state.provider}
                    />
                  )}
                </fieldset>
                <div className="settings-save-bar">
                  <span className="settings-save-summary">
                    {Object.keys(dirty).length
                      ? t('settings.saveBar.unsaved', { count: Object.keys(dirty).length })
                      : t('settings.saveBar.allSaved')}
                  </span>
                  <button
                    type="button"
                    className="button secondary"
                    disabled={busy || !Object.keys(dirty).length}
                    onClick={() => {
                      setDraft(base);
                      setNotice('');
                    }}
                  >
                    {t('settings.saveBar.discard')}
                  </button>
                  <button
                    type="submit"
                    className="button primary"
                    disabled={busy || !Object.keys(dirty).length}
                  >
                    <Save size={14} />
                    {busy ? t('settings.saveBar.saving') : t('settings.saveBar.save')}
                  </button>
                </div>
              </form>
            </>
          ) : null}
        </div>
      </div>
    </section>
  );
}
