import {
  ArrowLeft,
  BookOpen,
  Bot,
  Brain,
  CalendarDays,
  Check,
  ClipboardCheck,
  Coins,
  Eye,
  FileText,
  FlaskConical,
  Gauge,
  KeyRound,
  Library,
  Lightbulb,
  ListChecks,
  Plug,
  Puzzle,
  Rocket,
  Route,
  Save,
  Search,
  Send,
  ShieldCheck,
  SlidersHorizontal,
  SquareTerminal,
  Stethoscope,
  Users,
  WandSparkles,
  Wrench,
  X,
} from 'lucide-react';
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AvailabilitySettings } from './AvailabilitySettings';
import { unavailableAutonomyModes } from './autonomy-model';
import { availabilityIssue } from './availability-model';
import { availabilityWords } from './availability-words';
import { BrainPolicySettings } from './BrainPolicySettings';
import { ExecutionPolicySettings } from './ExecutionPolicySettings';
import { prepareExecutionPolicyPatch } from './execution-policy-model';
import { FleetPolicySettings } from './FleetPolicySettings';
import { fleetPolicyIssue } from './fleet-policy-model';
import { IntegrationSettings } from './IntegrationSettings';
import { KanbanCompanionSettings } from './KanbanCompanionSettings';
import { PluginInstaller } from './PluginInstaller';
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
import { settingsSearchWords } from './settings-search-words';
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
import { useInitialSettingsSection } from './settings-initial-section';
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

const settingsNavigation = [
  { id: 'setup', title: 'Quick setup', Icon: Rocket, group: 'Models' },
  { id: 'providers', title: 'Providers & models', Icon: KeyRound, group: 'Models' },
  { id: 'models', title: 'Model catalog', Icon: Library, group: 'Models' },
  { id: 'model-visibility', title: 'Model visibility', Icon: Eye, group: 'Models' },
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
    Icon: WandSparkles,
    group: 'Conversations',
  },
  {
    id: 'context',
    title: 'Context & reasoning',
    Icon: Lightbulb,
    group: 'Conversations',
  },
  {
    id: 'instructions',
    title: 'Global instructions',
    Icon: FileText,
    group: 'Conversations',
  },
  {
    id: 'resource-limits',
    title: 'Resource limits',
    Icon: SlidersHorizontal,
    group: 'Conversations',
  },
  {
    id: 'reviews',
    title: 'Review policy',
    Icon: ClipboardCheck,
    group: 'Conversations',
  },
  { id: 'capabilities', title: 'Capabilities', Icon: Puzzle, group: 'Agents & tools' },
  {
    id: 'tool-access',
    title: 'Tool availability',
    Icon: Wrench,
    group: 'Agents & tools',
  },
  { id: 'fleet', title: 'Fleet & companions', Icon: Users, group: 'Agents & tools' },
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
] as const;

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
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loading, setLoading] = useState(true);
  const operation = useRef(false);
  const detail = useRef<HTMLElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const navigation = useRef<'focus' | 'scroll' | null>(null);
  const { t, i18n } = useDesktopText();
  const searchWords = settingsSearchWords(i18n.resolvedLanguage ?? i18n.language ?? 'en');
  const [modelsOpened, setModelsOpened] = useState(false);
  const [brainOpened, setBrainOpened] = useState(false);
  const [instructionDraft, setInstructionDraft] = useState<InstructionDraft>({
    document: null,
    text: '',
  });
  const [section, setSection] = useInitialSettingsSection(state),
    [base, setBase] = useState<Record<string, unknown>>({}),
    [draft, setDraft] = useState<Record<string, unknown>>({}),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  useRequestedSettingsSection((wanted) => {
    openSection(wanted, true);
  });
  useReportSettingsSection(section);
  useLayoutEffect(() => {
    const target = detail.current;
    if (!target || !navigation.current) return;
    const scroll = target.closest('.main-content');
    if (scroll) scroll.scrollTop = 0;
    if (navigation.current === 'focus') target.focus({ preventScroll: true });
    navigation.current = null;
  }, [section, state.connected]);
  useEffect(() => {
    if (!state.connected || loaded) return;
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
        if (active) setError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [state.connected, command, loaded, loadAttempt]);
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
        'Concurrent agents, Memory Companion, Explore Companion, Skill Companion, next-step guidance and the project-wide Kanban Companion switch.',
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
  const sections = settingsNavigation.map((item) => ({
    ...item,
    english: item.title,
    title: t(`settings.section.${item.id}`),
    group: t(`settings.groups.${SETTINGS_GROUP_KEY[item.group]}`),
  }));
  const needle = search.trim().toLocaleLowerCase();
  const shown = sections.filter((item) => {
    if (!needle) return true;
    const registered = settingsSections.find((entry) => entry.id === item.id);
    const words =
      registered?.fields.map(
        (field) =>
          `${field.label} ${field.description} ${t(`fields.${field.key}.label`, { defaultValue: '' })} ${t(`fields.${field.key}.description`, { defaultValue: '' })}`,
      ) ?? [];
    const description = advanced[item.id]?.description ?? '';
    return [
      item.title,
      item.english,
      item.group,
      description,
      t(`advanced.${item.id}`, { defaultValue: '' }),
      ...words,
    ]
      .join(' ')
      .toLocaleLowerCase()
      .includes(needle);
  });
  const currentSection = sections.find((item) => item.id === section) ?? sections[0]!;
  const pickerSections = sections.filter((item) => item.id === section || shown.includes(item));
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
    if (operation.current || !Object.keys(dirty).length) return;
    operation.current = true;
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
      operation.current = false;
      setBusy(false);
    }
  };
  const reload = async () => {
    if (operation.current) return;
    if (!loaded) {
      setLoading(true);
      setError('');
      setLoadAttempt((attempt) => attempt + 1);
      return;
    }
    operation.current = true;
    setBusy(true);
    try {
      const {
        requestId: _requestId,
        sessionId: _sessionId,
        ...saved
      } = await command('prefs.get', {}, ['prefs.updated']);
      setBase(saved);
      setDraft(saved);
      setError('');
      setNotice('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      operation.current = false;
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
  function openSection(id: string, focusContent = false) {
    if (id === section) {
      if (focusContent) detail.current?.focus();
      return;
    }
    navigation.current = focusContent ? 'focus' : 'scroll';
    if (id === 'models') setModelsOpened(true);
    if (id === 'brain') setBrainOpened(true);
    setSection(id);
  }
  const clearSearch = () => {
    setSearch('');
    searchInput.current?.focus();
  };
  const feedback = (
    <>
      {error && (
        <div className="session-error settings-feedback-error" role="alert">
          <span>{localizedText(error, 'settingsMessage', t)}</span>
          <button
            type="button"
            className="button secondary small"
            disabled={busy || (!loaded && loading)}
            onClick={() => void reload()}
          >
            {loaded ? t('settings.saveBar.reloadSaved') : t('gate.retry')}
          </button>
        </div>
      )}
      <div className={notice ? 'studio-notice settings-notice' : 'settings-notice'} role="status">
        {notice && (
          <>
            <Check size={13} aria-hidden="true" />
            {localizedText(notice, 'settingsMessage', t)}
          </>
        )}
      </div>
    </>
  );
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
          <div className="settings-search">
            <Search size={15} aria-hidden="true" />
            <input
              ref={searchInput}
              aria-label={t('settings.search')}
              placeholder={t('settings.find')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && search) {
                  e.stopPropagation();
                  clearSearch();
                }
              }}
            />
            {search && (
              <button type="button" aria-label={searchWords.clear} onClick={clearSearch}>
                <X size={15} aria-hidden="true" />
              </button>
            )}
          </div>
          <SettingsSectionSelect
            sections={pickerSections}
            section={section}
            onSelect={openSection}
          />
          <p className="settings-search-status" role="status">
            {!shown.length && searchWords.empty}
          </p>
          {shown.map(({ id, title, Icon, group }, index) => (
            <Fragment key={id}>
              {shown[index - 1]?.group !== group && (
                <small className="settings-nav-group">{group}</small>
              )}
              <button
                type="button"
                aria-current={section === id ? 'page' : undefined}
                onClick={() => openSection(id, true)}
              >
                <Icon size={16} aria-hidden="true" />
                <span>{title}</span>
              </button>
            </Fragment>
          ))}
        </nav>
        <section
          className="settings-detail"
          aria-label={currentSection.title}
          tabIndex={-1}
          ref={detail}
        >
          <div className="settings-category">
            <currentSection.Icon size={14} aria-hidden="true" />
            {currentSection.group}
          </div>
          {(!loaded || !heading || section === 'brain') && feedback}
          {!heading && Object.keys(dirty).length > 0 && (
            <p className="settings-draft-note">
              {t('settings.saveBar.unsaved', { count: Object.keys(dirty).length })}
            </p>
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
            loading && (
              <p className="quiet-state" role="status">
                {t('settings.loading')}
              </p>
            )
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
              <BackgroundServices command={command} autoHeals={state.serviceHealing} />
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
              <div className="settings-defaults-note">{t('settings.defaultsNote')}</div>
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
                        unavailableOptions={
                          field.key === 'autonomy'
                            ? unavailableAutonomyModes(
                                state.results['session.start'],
                                t('autonomyControl.eternalUnavailable'),
                              )
                            : undefined
                        }
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
                  <div className="settings-save-feedback">{feedback}</div>
                  <span
                    className="settings-save-summary"
                    data-dirty={Object.keys(dirty).length > 0}
                  >
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
                      setError('');
                      setNotice('');
                    }}
                  >
                    {t('settings.saveBar.discard')}
                  </button>
                  <button
                    type="submit"
                    className="button primary"
                    aria-disabled={busy || !Object.keys(dirty).length}
                  >
                    <Save size={14} aria-hidden="true" />
                    {busy ? t('settings.saveBar.saving') : t('settings.saveBar.save')}
                  </button>
                </div>
              </form>
              {section === 'capabilities' && <PluginInstaller command={command} />}
              {section === 'fleet' && (
                <KanbanCompanionSettings projectId={vm.currentProject?.id ?? ''} />
              )}
            </>
          ) : null}
        </section>
      </div>
    </section>
  );
}
