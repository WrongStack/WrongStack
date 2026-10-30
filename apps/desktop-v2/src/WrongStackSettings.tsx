import {
  ArrowLeft,
  BookOpen,
  Bot,
  Brain,
  CalendarDays,
  Check,
  ChevronRight,
  Coins,
  Gauge,
  KeyRound,
  Layers3,
  ListChecks,
  Plug,
  Route,
  Save,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Wrench,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { AvailabilitySettings } from './AvailabilitySettings';
import { availabilityIssue } from './availability-model';
import { BrainPolicySettings } from './BrainPolicySettings';
import { ExecutionPolicySettings } from './ExecutionPolicySettings';
import { prepareExecutionPolicyPatch } from './execution-policy-model';
import { FleetPolicySettings } from './FleetPolicySettings';
import { fleetPolicyIssue } from './fleet-policy-model';
import { IntegrationSettings } from './IntegrationSettings';
import { RefinementPolicySettings } from './RefinementPolicySettings';
import { prepareRefinementPolicyPatch } from './refinement-policy-model';
import { ToolAccessSettings } from './ToolAccessSettings';
import { type InstructionDraft, UserInstructionsSettings } from './UserInstructionsSettings';
import './settings-management.css';
import { FallbackPolicySettings, RoutingPolicySettings } from './ModelPolicySettings';
import { LimitsPolicySettings, TierPolicySettings } from './ResourcePolicySettings';
import { prepareSettingsPatch, sameSetting } from './settings-save-model';
import './settings-policy.css';
import { BackgroundServices } from './BackgroundServices';
import { BrainDecisions } from './BrainDecisions';
import { ConfigDoctor } from './ConfigDoctor';
import { JevSettings } from './JevSettings';
import { ModelCatalogSettings } from './ModelCatalogSettings';
import { ModelVisibilitySettings } from './ModelVisibilitySettings';
import { ProviderDiagnostics } from './ProviderDiagnostics';
import { ProviderHealth } from './ProviderHealth';
import { ProviderSettings } from './ProviderSettings';
import { request } from './platform';
import { ReviewPolicySettings } from './ReviewPolicySettings';
import { RuntimeGate } from './RuntimeGate';
import { reviewPolicyIssue } from './review-policy-model';
import { SystemPromptPresets } from './SystemPromptPresets';
import './review-policy.css';
import { SkillLibrary } from './SkillLibrary';
import { changedSettings, type SettingField, settingsSections } from './settings-fields';
import type { DesktopController } from './useDesktop';
import { useProfileEngine } from './useEngine';

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
  const [modelsOpened, setModelsOpened] = useState(false);
  const [brainOpened, setBrainOpened] = useState(false);
  const [instructionDraft, setInstructionDraft] = useState<InstructionDraft>({
    document: null,
    text: '',
  });
  const [section, setSection] = useState('providers'),
    [base, setBase] = useState<Record<string, unknown>>({}),
    [draft, setDraft] = useState<Record<string, unknown>>({}),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
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
        const issue = availabilityIssue(patch['modelAvailabilitySchedule']);
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
        if (!sameSetting(result[key], value))
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
        <h2>Loading your WrongStack profile…</h2>
      </div>
    );
  return (
    <section className="wrongstack-settings" aria-label="WrongStack settings">
      <header className="wrongstack-settings-heading">
        <div>
          <span className="eyebrow">WRONGSTACK · ACTIVE PROFILE</span>
          <h1>
            WrongStack settings<span className="heading-dot">.</span>
          </h1>
          <p>Models, capabilities, and defaults shared with your WrongStack tools.</p>
        </div>
        {vm.settingsReturnSession && (
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
            Back to conversation
          </button>
        )}
      </header>
      <div className="settings-workspace">
        <nav className="settings-navigation" aria-label="WrongStack settings sections">
          <label className="settings-search">
            <Search size={14} />
            <input
              aria-label="Search WrongStack settings"
              placeholder="Find a setting…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          {(
            [
              { id: 'providers', title: 'Providers & models', Icon: KeyRound },
              { id: 'models', title: 'Model catalog', Icon: Layers3 },
              { id: 'model-visibility', title: 'Model visibility', Icon: Layers3 },
              { id: 'execution', title: 'Execution & permissions', Icon: ShieldCheck },
              { id: 'refinement', title: 'Prompt refinement', Icon: Sparkles },
              { id: 'context', title: 'Context & reasoning', Icon: Brain },
              { id: 'instructions', title: 'Global instructions', Icon: BookOpen },
              { id: 'capabilities', title: 'Capabilities', Icon: Layers3 },
              { id: 'tool-access', title: 'Tool availability', Icon: Wrench },
              { id: 'routing', title: 'Fallbacks & agent defaults', Icon: Bot },
              { id: 'fleet', title: 'Fleet & companions', Icon: Layers3 },
              { id: 'brain', title: 'Brain policy', Icon: Brain },
              { id: 'model-routing', title: 'Model routing', Icon: Route },
              { id: 'cost-tiers', title: 'Cost tiers', Icon: Coins },
              { id: 'resource-limits', title: 'Resource limits', Icon: SlidersHorizontal },
              { id: 'reviews', title: 'Review policy', Icon: ShieldCheck },
              { id: 'availability', title: 'Model availability', Icon: CalendarDays },
              { id: 'integrations', title: 'Connected tools', Icon: Plug },
              { id: 'skills', title: 'Profile skills', Icon: BookOpen },
              { id: 'health', title: 'Provider diagnostics', Icon: Gauge },
              { id: 'logging', title: 'Logs & diagnostics', Icon: ListChecks },
            ] as const
          )
            .filter(
              (item) =>
                !search.trim() ||
                (
                  item.title +
                  ' ' +
                  (settingsSections
                    .find((s) => s.id === item.id)
                    ?.fields.map((f) => f.label + ' ' + f.description)
                    .join(' ') ?? '') +
                  ' ' +
                  (advanced[item.id]?.description ?? '')
                )
                  .toLowerCase()
                  .includes(search.toLowerCase()),
            )
            .map(({ id, title, Icon }) => (
              <button
                type="button"
                key={id}
                aria-current={section === id ? 'page' : undefined}
                onClick={() => {
                  if (id === 'models') setModelsOpened(true);
                  if (id === 'brain') setBrainOpened(true);
                  setSection(id);
                }}
              >
                <Icon size={16} />
                <span>{title}</span>
                <ChevronRight size={12} />
              </button>
            ))}
          <div className="settings-scope-note">
            <SlidersHorizontal size={16} />
            <p>
              Appearance belongs to Desktop settings. These controls configure WrongStack itself.
            </p>
            <button type="button" onClick={() => vm.setSection('engine')}>
              Desktop appearance
              <ChevronRight size={12} />
            </button>
          </div>
        </nav>
        <div className="settings-detail">
          {error && (
            <div className="session-error" role="alert">
              {error}
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
                Reload saved values (discard drafts)
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
            <ToolAccessSettings command={command} />
          ) : heading ? (
            <>
              <header className="settings-section-heading">
                <div>
                  <h2>{heading.title}</h2>
                  <p>{heading.description}</p>
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
                  {fields?.fields.map((field) => (
                    <SettingRow
                      key={field.key}
                      field={field}
                      value={draft[field.key]}
                      onChange={(value) => change(field.key, value)}
                    />
                  ))}
                  {section === 'routing' && (
                    <FallbackPolicySettings draft={draft} change={change} command={command} />
                  )}
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
                      ? `${Object.keys(dirty).length} unsaved changes`
                      : 'All changes saved'}
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
                    Discard changes
                  </button>
                  <button
                    type="submit"
                    className="button primary"
                    disabled={busy || !Object.keys(dirty).length}
                  >
                    <Save size={14} />
                    {busy ? 'Saving…' : 'Save settings'}
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
function SettingRow({
  field,
  value,
  onChange,
}: {
  field: SettingField;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const options = field.options ?? [];
  const labels: Record<string, string> = {
    off: 'Off',
    suggest: 'Suggest next steps',
    auto: 'Automatic',
    eternal: 'Continuous',
    'eternal-parallel': 'Continuous, parallel',
    hybrid: 'Hybrid',
    intelligent: 'Intelligent',
    selective: 'Selective',
    balanced: 'Balanced',
    frugal: 'Frugal',
    deep: 'Deep',
    lite: 'Compact',
    default: 'Default',
    pro: 'Full operating instructions',
    '5m': '5 minutes',
    '1h': '1 hour',
  };
  return (
    <div className={`setting-row setting-${field.kind}`}>
      <div>
        <label htmlFor={`setting-${field.key}`}>{field.label}</label>
        <p>{field.description}</p>
        {value === undefined && <small>Not reported by this engine</small>}
      </div>
      <div className="setting-control">
        {field.kind === 'toggle' ? (
          <button
            type="button"
            id={`setting-${field.key}`}
            role="switch"
            aria-checked={value === true}
            aria-label={field.label}
            className="settings-switch"
            onClick={() => onChange(value !== true)}
          >
            <span className="settings-switch-thumb" />
          </button>
        ) : field.kind === 'select' ? (
          <select
            id={`setting-${field.key}`}
            value={typeof value === 'string' ? value : ''}
            onChange={(event) => onChange(event.target.value)}
          >
            <option value="" disabled>
              Choose a value
            </option>
            {[...new Set([...options, ...(typeof value === 'string' ? [value] : [])])].map(
              (option) => (
                <option key={option} value={option}>
                  {labels[option] ?? option[0]!.toUpperCase() + option.slice(1)}
                </option>
              ),
            )}
          </select>
        ) : field.kind === 'number' ? (
          <span className="settings-number">
            <input
              id={`setting-${field.key}`}
              type="number"
              min={field.min ?? 0}
              required
              value={typeof value === 'number' ? value : ''}
              onChange={(event) =>
                onChange(event.target.value === '' ? undefined : Number(event.target.value))
              }
            />
            {field.unit && <span>{field.unit}</span>}
          </span>
        ) : (
          <textarea
            id={`setting-${field.key}`}
            rows={5}
            value={Array.isArray(value) ? value.join('\n') : ''}
            onChange={(event) =>
              onChange(
                event.target.value
                  .split('\n')
                  .map((value) => value.trim())
                  .filter(Boolean),
              )
            }
            placeholder="One model identifier per line"
          />
        )}
      </div>
    </div>
  );
}
