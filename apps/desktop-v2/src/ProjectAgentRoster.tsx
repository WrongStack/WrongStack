import {
  BookOpen,
  Brain,
  Check,
  Copy,
  FileCode2,
  GitFork,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Settings2,
  Sparkles,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand } from './engine-operations';
import { durationText, entries, record } from './engine-values';
import { MarkdownContent } from './MarkdownContent';
import { Modal } from './Modal';
import { markdownTarget } from './markdown-target';
import type { Session } from './model';
import { openExternal, projectFormDraftStorage } from './platform';
import { RosterDocument, type RosterDocumentKind } from './RosterDocument';
import { RosterKnowledgeChecklist } from './RosterKnowledgeChecklist';
import { rosterInputDraft } from './roster-document-store';
import { rosterInputsToKeep } from './roster-input-draft';
import { type RosterRecord, rosterBudgetFields, rosterCatalog } from './roster-model';
import { usePersistedFields } from './usePersistedFields';
import './project-agent-roster.css';
import { displayDecimal, displayLocale } from './display-dates';

const RosterRuntimeEditor = lazy(() =>
  import('./RosterRuntimeEditor').then((module) => ({ default: module.RosterRuntimeEditor })),
);
const RosterInheritance = lazy(() =>
  import('./RosterInheritance').then((module) => ({ default: module.RosterInheritance })),
);
const string = (value: unknown) => (typeof value === 'string' ? value : '');
const count = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString(displayLocale()) : '—';
const date = (value: unknown) => {
  const parsed = new Date(typeof value === 'number' ? value : String(value));
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toLocaleString(displayLocale());
};
type Section = 'overview' | 'learning' | 'skills';
const chrome = new Map<
  string,
  { selected: string; section: Section; query: string; filter: string }
>();
type RoleInputs = {
  teach: string;
  improve: string;
  instruction: string;
  capture?: string;
  captureResult?: RosterRecord;
};
const inputDrafts = new Map<string, Record<string, RoleInputs>>();
const createDefaults = { name: '', role: '', purpose: '', taskTypes: '', baseRole: 'generic' };
export function ProjectAgentRoster({
  command,
  projectId,
  projectName,
  events,
  sessions,
  onPrepare,
  onNewSession,
  onOpenFile,
}: {
  command: EngineCommand;
  projectId: string;
  projectName: string;
  events: Record<string, RosterRecord>;
  sessions: Session[];
  onPrepare: (id: string, text: string) => void;
  onNewSession: () => void;
  onOpenFile: (path: string) => void;
}) {
  const { t } = useDesktopText();
  const cached = chrome.get(projectId);
  const [catalog, setCatalog] = useState<RosterRecord[]>([]),
    [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState(cached?.selected ?? ''),
    [section, setSection] = useState<Section>(cached?.section ?? 'overview');
  const [query, setQuery] = useState(cached?.query ?? ''),
    [filter, setFilter] = useState(cached?.filter ?? 'all');
  const [tools, setTools] = useState<string[]>([]),
    [skills, setSkills] = useState<string[]>([]);
  const [detail, setDetail] = useState<RosterRecord>({}),
    [detailLoading, setDetailLoading] = useState(false),
    [detailError, setDetailError] = useState('');
  const [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [revision, setRevision] = useState(0);
  const [create, setCreate] = useState(false);
  // The unsent role-creation form is kept per project until a role is created or cleared.
  const createStorage = useMemo(
    () => projectFormDraftStorage(projectId, 'roster-create'),
    [projectId],
  );
  const createInput = usePersistedFields(createStorage, 'roster-create', createDefaults);
  const createDraft = createInput.fields;
  const setCreateDraft = (value: typeof createDefaults) => createInput.set(value);
  const [runtime, setRuntime] = useState(false),
    [document, setDocument] = useState<{ kind: RosterDocumentKind; skill?: string } | null>(null);
  const [confirmation, setConfirmation] = useState<{
      action: 'reset' | 'clear-consolidated' | 'clear-skill' | 'optimize';
      role: string;
      skill?: string;
    } | null>(null),
    [confirmText, setConfirmText] = useState('');
  const [inputs, setInputs] = useState<Record<string, RoleInputs>>(
    inputDrafts.get(projectId) ?? {},
  );
  const [targetSession, setTargetSession] = useState('');
  const roleInput = inputs[selected] ?? { teach: '', improve: '', instruction: '' };
  const { teach, improve, instruction } = roleInput;
  const capture = roleInput.capture ?? '';
  const [overlap, setOverlap] = useState<RosterRecord[] | null>(null);
  const updateInput = (patch: Partial<RoleInputs> | ((value: RoleInputs) => Partial<RoleInputs>)) =>
    setInputs((current) => {
      const previous = { teach: '', improve: '', instruction: '', ...current[selected] };
      return {
        ...current,
        [selected]: { ...previous, ...(typeof patch === 'function' ? patch(previous) : patch) },
      };
    });
  const setTeach = (text: string) => updateInput({ teach: text });
  const setImprove = (text: string) => updateInput({ improve: text });
  const setInstruction = (text: string) => updateInput({ instruction: text });
  const [graph, setGraph] = useState(false),
    [visible, setVisible] = useState(100),
    [directiveQuery, setDirectiveQuery] = useState('');
  const mounted = useRef(true),
    catalogSequence = useRef(0),
    detailSequence = useRef(0),
    busyRef = useRef(false);
  useEffect(() => {
    chrome.set(projectId, { selected, section, query, filter });
  }, [projectId, selected, section, query, filter]);
  useEffect(() => {
    inputDrafts.set(projectId, inputs);
  }, [projectId, inputs]);
  // Unsent role text is also kept on this device; typed text already in this window wins.
  const inputStore = useMemo(() => rosterInputDraft(projectId), [projectId]);
  const inputState = useSyncExternalStore(inputStore.subscribe, inputStore.snapshot);
  const [inputsHydrated, setInputsHydrated] = useState(false);
  useEffect(() => {
    let active = true;
    void inputStore.load().then(() => {
      if (!active) return;
      const saved = inputStore.snapshot().value;
      if (saved)
        setInputs((current) => {
          const merged = { ...current };
          for (const [role, value] of Object.entries(saved))
            if (!rosterInputsToKeep({ [role]: current[role] ?? {} })) merged[role] = { ...value };
          return merged;
        });
      setInputsHydrated(true);
    });
    return () => {
      active = false;
    };
  }, [inputStore]);
  useEffect(() => {
    if (!inputsHydrated || !inputState.ready || inputState.review) return;
    const next = rosterInputsToKeep(inputs);
    if (JSON.stringify(next) === JSON.stringify(inputStore.snapshot().value)) return;
    inputStore.edit(next);
  }, [inputs, inputsHydrated, inputState.ready, inputState.review, inputStore]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      catalogSequence.current++;
      detailSequence.current++;
    };
  }, []);
  const load = useCallback(async () => {
    const version = ++catalogSequence.current;
    const reply = await command('agent-roster.list', {}, ['agent-roster.list']);
    if (!mounted.current || catalogSequence.current !== version) return;
    setCatalog(rosterCatalog(reply));
    setLoaded(true);
  }, [command]);
  const refresh = useCallback(async () => {
    await load();
    if (mounted.current) setRevision((value) => value + 1);
  }, [load]);
  useEffect(() => {
    void load().catch((error) => {
      if (mounted.current) setError(String(error));
    });
    void Promise.allSettled([
      command('tools.list', {}, ['tools.list']),
      command('skills.list', {}, ['skills.list']),
    ]).then((results) => {
      if (!mounted.current) return;
      if (results[0].status === 'fulfilled')
        setTools(
          entries(results[0].value['tools'])
            .map((entry) => string(entry['name']))
            .filter(Boolean),
        );
      if (results[1].status === 'fulfilled')
        setSkills(
          entries(results[1].value['skills'])
            .map((entry) => string(entry['name']))
            .filter(Boolean),
        );
    });
  }, [command, load]);
  const changed = events['agent-roster.updated'];
  useEffect(() => {
    if (!changed) return;
    const timer = setTimeout(() => {
      if (!busyRef.current) void refresh().catch((error) => setError(String(error)));
    }, 300);
    return () => clearTimeout(timer);
  }, [changed, refresh]);
  useEffect(() => {
    const version = ++detailSequence.current;
    setDetail({});
    setDetailError('');
    setDirectiveQuery('');
    if (!selected) return;
    setDetailLoading(true);
    const requests: Array<[string, Record<string, unknown>]> = [
      ['agent-roster.read-customization', { role: selected, includeDocuments: false }],
      ['agent-roster.stats', { role: selected }],
    ];
    if (section === 'learning')
      requests.push(
        ['agent-roster.read-learned', { role: selected }],
        ['agent-roster.read-consolidated', { role: selected }],
        ['agent-roster.quarantine', { role: selected }],
        ['agent-roster.auto-optimize-status', { role: selected }],
      );
    if (section === 'skills') requests.push(['agent-roster.skills', { role: selected }]);
    void Promise.allSettled(
      requests.map(
        async ([type, payload]) => [type, await command(type, payload, [type])] as const,
      ),
    ).then((results) => {
      if (!mounted.current || detailSequence.current !== version) return;
      const data: RosterRecord = {},
        failures: string[] = [];
      for (const result of results) {
        if (result.status === 'fulfilled') data[result.value[0]] = result.value[1];
        else failures.push(String(result.reason));
      }
      setDetail(data);
      setDetailError(failures.join(' · '));
      setDetailLoading(false);
    });
    return () => {
      detailSequence.current++;
    };
  }, [command, selected, section, revision]);
  const row = catalog.find((entry) => entry['role'] === selected);
  const stats = record(detail['agent-roster.stats'] ?? row?.['stats']);
  const customization = record(detail['agent-roster.read-customization']);
  const effective = record(row?.['effective']);
  const run = async (fn: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await fn();
    } catch (error) {
      if (mounted.current) setError(error instanceof Error ? error.message : String(error));
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const link = (url: string) => {
    const target = markdownTarget(url);
    if (target?.kind === 'file') onOpenFile(target.value);
    else if (target?.kind === 'external')
      void openExternal(target.value).catch((error) => setError(String(error)));
  };
  const shown = catalog.filter(
    (entry) =>
      `${entry['role']} ${entry['name']} ${entry['summary']} ${(Array.isArray(entry['taskTypes']) ? entry['taskTypes'] : []).join(' ')}`
        .toLowerCase()
        .includes(query.toLowerCase()) &&
      (filter !== 'custom' || entry['custom'] === true) &&
      (filter !== 'builtin' || entry['systemProtected'] === true) &&
      (filter !== 'modified' || record(entry['stats'])['exists'] === true),
  );
  const confirm = async () => {
    if (!confirmation) return;
    const action = confirmation;
    if (action.action === 'reset') {
      if (confirmText !== (action.role === '*' ? projectName : action.role))
        throw Error(t('roster.typeName'));
      const reply = await command('agent-roster.reset', { role: action.role }, [
        'agent-roster.reset',
      ]);
      await refresh();
      setNotice(
        t('roster.removed', {
          count: Array.isArray(reply['removed']) ? reply['removed'].length : 0,
        }),
      );
      if (action.role === '*' || action.role === selected) setSelected('');
    } else if (action.action === 'clear-consolidated') {
      await command('agent-roster.clear-consolidated', { role: action.role }, [
        'agent-roster.clear-consolidated',
      ]);
      const readback = await command('agent-roster.read-consolidated', { role: action.role }, [
        'agent-roster.read-consolidated',
      ]);
      if (readback['content']) throw Error(t('roster.consolidatedStill'));
      await refresh();
      setNotice(t('roster.consolidatedCleared'));
    } else if (action.action === 'clear-skill') {
      await command('agent-roster.clear-skill', { role: action.role, skill: action.skill }, [
        'agent-roster.clear-skill',
      ]);
      const readback = await command(
        'agent-roster.read-skill',
        { role: action.role, skill: action.skill },
        ['agent-roster.read-skill'],
      );
      if (readback['content']) throw Error(t('roster.addendumStill'));
      await refresh();
      setNotice(t('roster.addendumCleared'));
    } else {
      const reply = await command('agent-roster.consolidate', { role: action.role }, [
        'agent-roster.consolidate',
      ]);
      await refresh();
      if (reply['consolidated'] === true)
        setNotice(
          t('roster.optimized', {
            count: Number(reply['rawEntryCount'] ?? 0),
            model: String(reply['model'] ?? t('roster.configuredModel')),
            skills: Array.isArray(reply['skills']) ? reply['skills'].length : 0,
            archived: reply['pruned'] === true ? t('roster.archived') : '',
          }),
        );
      else if (typeof reply['instruction'] === 'string') {
        setInstruction(reply['instruction']);
        setNotice(t('roster.instructionReady'));
      } else
        setNotice(
          reply['emptySynthesis'] === true
            ? t('roster.emptySynthesis')
            : t('roster.nothingPending'),
        );
    }
    setConfirmation(null);
    setConfirmText('');
  };
  return (
    <section className="project-agent-roster" aria-label={t('roster.label')}>
      <header className="roster-hero">
        <div>
          <h1>{t('roster.title')}</h1>
          <p>{t('roster.intro')}</p>
        </div>
        <div>
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={() => void run(refresh)}
          >
            <RefreshCw size={14} />
            {t('roster.refresh')}
          </button>
          <button type="button" className="button primary" onClick={() => setCreate(true)}>
            <Plus size={14} />
            {t('roster.create')}
          </button>
        </div>
      </header>
      <div className="roster-summary">
        <span>
          <Users size={17} />
          <strong>{loaded ? catalog.length : '—'}</strong>
          {t('roster.roles')}
        </span>
        <span>
          <GitFork size={17} />
          <strong>{catalog.filter((entry) => entry['custom'] === true).length}</strong>
          {t('roster.projectCreated')}
        </span>
        <span>
          <Brain size={17} />
          <strong>
            {catalog
              .reduce((sum, entry) => sum + Number(record(entry['stats'])['entryCount'] ?? 0), 0)
              .toLocaleString(displayLocale())}
          </strong>
          {t('roster.recordedDirectives')}
        </span>
        <button
          type="button"
          className="button secondary small"
          disabled={busy || !catalog.some((entry) => record(entry['stats'])['exists'] === true)}
          onClick={() => {
            setConfirmation({ action: 'reset', role: '*' });
            setConfirmText('');
          }}
        >
          {t('roster.resetAll')}
        </button>
      </div>
      {error && (
        <p role="alert" className="session-error">
          {error}
        </p>
      )}
      {inputState.error && (
        <p role="alert" className="session-error">
          {inputState.error}
        </p>
      )}
      {inputState.review && (
        <div className="roster-confirm" role="alert">
          <p>{t('roster.notesConflict')}</p>
          <button
            type="button"
            className="button secondary"
            onClick={() => void inputStore.resolve('local')}
          >
            {t('roster.keepWindowNotes')}
          </button>
          <button
            type="button"
            className="button secondary"
            onClick={() => {
              const saved = inputState.review?.value ?? {};
              void inputStore.resolve('saved').then((ok) => {
                if (ok) setInputs(structuredClone(saved));
              });
            }}
          >
            {t('roster.useSavedNotes')}
          </button>
        </div>
      )}
      {notice && (
        <p role="status" className="composer-notice">
          <Check size={14} />
          {notice}
        </p>
      )}
      <div className="roster-workbench">
        <aside className="roster-catalog">
          <label>
            {t('roster.find')}
            <input
              aria-label={t('roster.searchLabel')}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setVisible(100);
              }}
              placeholder={t('roster.searchPlaceholder')}
            />
          </label>
          <label>
            {t('roster.catalog')}
            <select
              aria-label={t('roster.filterLabel')}
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            >
              <option value="all">{t('roster.filter.all')}</option>
              <option value="builtin">{t('roster.filter.builtin')}</option>
              <option value="custom">{t('roster.filter.custom')}</option>
              <option value="modified">{t('roster.filter.modified')}</option>
            </select>
          </label>
          {!loaded ? (
            <p role="status">
              <LoaderCircle className="spin" size={16} />
              {t('roster.loading')}
            </p>
          ) : shown.length ? (
            <>
              {shown.slice(0, visible).map((entry) => (
                <button
                  type="button"
                  className="roster-catalog-card"
                  aria-pressed={selected === entry['role']}
                  key={String(entry['role'])}
                  onClick={() => {
                    setSelected(String(entry['role']));
                    setRuntime(false);
                    setDocument(null);
                  }}
                >
                  <span>
                    <strong>{String(entry['name'] ?? entry['role'])}</strong>
                    <small>
                      {entry['custom']
                        ? t('roster.kind.project')
                        : entry['systemProtected']
                          ? t('roster.kind.builtin')
                          : t('roster.kind.data')}
                    </small>
                  </span>
                  <code>{String(entry['role'])}</code>
                  <p>{String(entry['summary'] ?? '')}</p>
                  <footer>
                    <span>{t('roster.declaredTools', { count: Number(entry['tools'] ?? 0) })}</span>
                    <span>
                      {t('roster.directivesCount', {
                        count: count(record(entry['stats'])['entryCount']),
                      })}
                    </span>
                  </footer>
                </button>
              ))}
              {shown.length > visible && (
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => setVisible(visible + 100)}
                >
                  {t('roster.showMore', { count: shown.length - visible })}
                </button>
              )}
            </>
          ) : (
            <p>{t('roster.noMatch')}</p>
          )}
        </aside>
        <div className="roster-inspector">
          {!row ? (
            <div className="roster-empty">
              <Users size={36} />
              <h2>{t('roster.choose')}</h2>
              <p>{t('roster.chooseHelp')}</p>
            </div>
          ) : (
            <>
              <header className="roster-role-header">
                <div>
                  <span className="eyebrow">
                    {row['systemProtected']
                      ? t('roster.eyebrow.builtin')
                      : t('roster.eyebrow.project')}{' '}
                    · {selected}
                  </span>
                  <h2>{String(row['name'] ?? selected)}</h2>
                  <p>{String(row['summary'] ?? '')}</p>
                  {Boolean(row['baseRole']) && (
                    <small>{t('roster.basedOn', { role: String(row['baseRole']) })}</small>
                  )}
                </div>
                <button
                  type="button"
                  className="button secondary small"
                  onClick={() => setGraph(!graph)}
                >
                  <GitFork size={14} />
                  {graph ? t('roster.hideInheritance') : t('roster.inheritance')}
                </button>
              </header>
              {graph && (
                <Suspense fallback={<p>{t('roster.openingInheritance')}</p>}>
                  <RosterInheritance catalog={catalog} selected={selected} onSelect={setSelected} />
                </Suspense>
              )}
              <nav className="roster-sections" aria-label={t('roster.sectionsLabel')}>
                {(['overview', 'learning', 'skills'] as const).map((id) => (
                  <button
                    type="button"
                    key={id}
                    aria-current={section === id ? 'page' : undefined}
                    onClick={() => setSection(id)}
                  >
                    {t(`roster.section.${id}`)}
                  </button>
                ))}
              </nav>
              {detailLoading && (
                <p role="status">
                  <LoaderCircle className="spin" size={14} />
                  {t('roster.reading', { role: selected })}
                </p>
              )}
              {detailError && (
                <p role="alert" className="session-error">
                  {detailError}
                </p>
              )}
              {section === 'overview' && (
                <>
                  <div className="roster-role-actions">
                    <button
                      type="button"
                      className="button secondary"
                      disabled={detailLoading || !Object.keys(customization).length}
                      onClick={() => setDocument({ kind: 'identity' })}
                    >
                      <BookOpen size={14} />
                      {t('roster.readIdentity')}
                    </button>
                    <button
                      type="button"
                      className="button primary"
                      disabled={
                        detailLoading ||
                        !Object.keys(customization).length ||
                        customization['configState'] === 'unreadable'
                      }
                      onClick={() => setRuntime(true)}
                    >
                      <Settings2 size={14} />
                      {t('roster.editRuntime')}
                    </button>
                    <button
                      type="button"
                      className="button secondary"
                      onClick={() => onOpenFile(`.wrongstack/agents/${selected}/config.json`)}
                    >
                      <FileCode2 size={14} />
                      {t('roster.configFile')}
                    </button>
                  </div>
                  {customization['configState'] === 'unreadable' && (
                    <p className="session-error" role="alert">
                      {t('roster.configUnreadable')}
                    </p>
                  )}
                  <section className="roster-facts">
                    <h3>{t('roster.documents')}</h3>
                    <dl>
                      <dt>{t('roster.localIdentity')}</dt>
                      <dd>
                        {stats['hasIdentity'] === true
                          ? t('roster.present')
                          : stats['hasIdentity'] === false
                            ? t('roster.notStored')
                            : t('roster.notReported')}
                      </dd>
                      <dt>{t('roster.runtimeConfig')}</dt>
                      <dd>
                        {typeof customization['configState'] === 'string'
                          ? t(`roster.configState_${customization['configState']}`, {
                              defaultValue: customization['configState'],
                            })
                          : t('roster.loadingValue')}
                      </dd>
                      <dt>{t('roster.knowledgeChecklist')}</dt>
                      <dd>
                        {stats['hasKnowledge'] === true
                          ? t('roster.present')
                          : t('roster.notStored')}
                      </dd>
                      <dt>{t('roster.lastLearning')}</dt>
                      <dd>{date(stats['lastCapture']) || t('roster.notRecorded')}</dd>
                      <dt>{t('roster.taskTypes')}</dt>
                      <dd>
                        {Array.isArray(row['taskTypes']) && row['taskTypes'].length
                          ? row['taskTypes'].join(', ')
                          : t('roster.catalogDefault')}
                      </dd>
                    </dl>
                  </section>
                  <ResolvedRosterRuntime value={effective} />
                  <section className="roster-improve">
                    <h3>{t('roster.improveTitle')}</h3>
                    <p>{t('shellText.rosterImprove')}</p>
                    <textarea
                      aria-label={t('roster.improveLabel')}
                      value={improve}
                      onChange={(event) => setImprove(event.target.value)}
                      placeholder={t('roster.improvePlaceholder')}
                    />
                    <button
                      type="button"
                      className="button secondary"
                      disabled={busy || !improve.trim()}
                      onClick={() =>
                        void run(async () => {
                          const reply = await command(
                            'agent-roster.llm-improve',
                            { role: selected, prompt: improve },
                            ['agent-roster.llm-improve'],
                          );
                          if (typeof reply['instruction'] !== 'string')
                            throw Error(t('roster.noImprovement'));
                          setInstruction(reply['instruction']);
                        })
                      }
                    >
                      <Sparkles size={14} />
                      {t('roster.prepareImprovement')}
                    </button>
                  </section>
                </>
              )}
              {section === 'learning' && (
                <>
                  <RosterKnowledgeChecklist
                    key={selected}
                    role={selected}
                    command={command}
                    disabled={busy}
                  />
                  <div className="roster-learning-metrics">
                    {[
                      [t('roster.metric.directives'), stats['entryCount']],
                      [t('roster.metric.bufferBytes'), stats['totalBytes']],
                      [t('roster.metric.lifetime'), stats['lifetimeCaptureCount']],
                      [t('roster.metric.applied'), stats['appliedEntryCount']],
                      [t('roster.metric.dead'), stats['deadEntryCount']],
                      [t('roster.metric.measured'), stats['measuredEntryCount']],
                    ].map(([label, value]) => (
                      <div key={String(label)}>
                        <strong>{count(value)}</strong>
                        <span>{String(label)}</span>
                      </div>
                    ))}
                  </div>
                  <p className="roster-policy-note">
                    {t('roster.lift', {
                      lift:
                        typeof stats['directiveLift'] === 'number'
                          ? displayDecimal(stats['directiveLift'], 3)
                          : t('roster.notEnoughEvidence'),
                      rate:
                        typeof stats['directiveHitRate'] === 'number'
                          ? `${displayDecimal(stats['directiveHitRate'] * 100, 1)}%`
                          : t('roster.notMeasured'),
                    })}
                  </p>
                  <div className="roster-role-actions">
                    <button
                      type="button"
                      className="button secondary"
                      onClick={() => setDocument({ kind: 'learned' })}
                    >
                      <Pencil size={14} />
                      {t('roster.editDirectives')}
                    </button>
                    <button
                      type="button"
                      className="button secondary"
                      onClick={() => setDocument({ kind: 'consolidated' })}
                    >
                      <BookOpen size={14} />
                      {t('roster.consolidated')}
                    </button>
                    <button
                      type="button"
                      className="button secondary"
                      disabled={busy || typeof stats['learningEnabled'] !== 'boolean'}
                      onClick={() =>
                        void run(async () => {
                          const current = await command('agent-roster.stats', { role: selected }, [
                            'agent-roster.stats',
                          ]);
                          if (current['learningEnabled'] !== stats['learningEnabled'])
                            throw Error(t('roster.policyChanged'));
                          await command(
                            'agent-roster.update-learning',
                            { role: selected, enabled: !stats['learningEnabled'] },
                            ['agent-roster.update-learning'],
                          );
                          await refresh();
                          setNotice(
                            stats['learningEnabled']
                              ? t('roster.learningPaused')
                              : t('roster.learningEnabled'),
                          );
                        })
                      }
                    >
                      {stats['learningEnabled'] === true
                        ? t('roster.pauseLearning')
                        : t('roster.enableLearning')}
                    </button>
                    <button
                      type="button"
                      className="button secondary"
                      disabled={busy}
                      onClick={() => setConfirmation({ action: 'optimize', role: selected })}
                    >
                      <Sparkles size={14} />
                      {t('roster.optimizeLearning')}
                    </button>
                    {stats['isConsolidated'] === true && (
                      <button
                        type="button"
                        className="button secondary danger"
                        onClick={() =>
                          setConfirmation({ action: 'clear-consolidated', role: selected })
                        }
                      >
                        {t('roster.clearConsolidated')}
                      </button>
                    )}
                  </div>
                  <section className="roster-teach">
                    <h3>{t('roster.teachTitle')}</h3>
                    <p>{t('roster.teachHelp')}</p>
                    <textarea
                      aria-label={t('roster.teachLabel')}
                      value={teach}
                      onChange={(event) => setTeach(event.target.value)}
                    />
                    <button
                      type="button"
                      className="button primary"
                      disabled={busy || !teach.trim()}
                      onClick={() =>
                        void run(async () => {
                          await command(
                            'agent-roster.append-learned',
                            { role: selected, content: teach },
                            ['agent-roster.append-learned'],
                          );
                          await refresh();
                          updateInput((current) => ({
                            teach: current.teach === teach ? '' : current.teach,
                          }));
                          setNotice(t('roster.directiveUpdated'));
                        })
                      }
                    >
                      <Plus size={14} />
                      {t('roster.addInstruction')}
                    </button>
                  </section>
                  <AutoOptimizeStatus data={record(detail['agent-roster.auto-optimize-status'])} />
                  <section className="roster-facts">
                    <h3>{t('roster.recordTitle')}</h3>
                    <dl>
                      <dt>{t('roster.lastCapture')}</dt>
                      <dd>
                        {date(stats['lastCapture']) || t('roster.notRecorded')}
                        {string(stats['lastCaptureSource']) && ` · ${stats['lastCaptureSource']}`}
                      </dd>
                      <dt>{t('roster.captureWindow')}</dt>
                      <dd>
                        {t('roster.captures', {
                          count: count(stats['sessionCaptureCount']),
                          cooldown:
                            typeof stats['cooldownRemainingMs'] === 'number'
                              ? `${Math.ceil(stats['cooldownRemainingMs'] / 1000)} s`
                              : t('roster.notReported'),
                        })}
                      </dd>
                      <dt>{t('roster.routedSkills')}</dt>
                      <dd>
                        {t('roster.directivesCount', { count: count(stats['skilledEntryCount']) })}
                      </dd>
                      <dt>{t('roster.recommendation')}</dt>
                      <dd>
                        {stats['needsSummarization'] === true
                          ? t('roster.bufferReady')
                          : stats['needsSummarization'] === false
                            ? t('roster.noRecommendation')
                            : t('roster.notReported')}
                      </dd>
                      {Object.entries(
                        record(record(detail['agent-roster.read-consolidated'])['metadata']),
                      )
                        .filter(([name]) =>
                          [
                            'consolidatedAt',
                            'sourceEntryCount',
                            'sourceBytes',
                            'consolidatedBytes',
                            'trigger',
                            'model',
                            'pruned',
                          ].includes(name),
                        )
                        .map(([name, value]) => (
                          <div className="roster-consolidation-fact" key={name}>
                            <dt>{t(`roster.fact.${name}`)}</dt>
                            <dd>
                              {name === 'consolidatedAt'
                                ? date(value) || t('roster.notRecorded')
                                : typeof value === 'boolean'
                                  ? value
                                    ? t('roster.yes')
                                    : t('roster.no')
                                  : String(value)}
                            </dd>
                          </div>
                        ))}
                    </dl>
                  </section>
                  <details className="roster-capture">
                    <summary>{t('roster.captureTitle')}</summary>
                    <p className="field-help">{t('roster.captureHelp')}</p>
                    <textarea
                      aria-label={t('roster.captureLabel')}
                      value={capture}
                      onChange={(event) => updateInput({ capture: event.target.value })}
                    />
                    <button
                      type="button"
                      className="button secondary"
                      disabled={busy || !capture.trim()}
                      onClick={() =>
                        void run(async () => {
                          const result = await command(
                            'agent-roster.capture',
                            { role: selected, output: capture },
                            ['agent-roster.capture'],
                          );
                          updateInput((current) => ({
                            captureResult: result,
                            ...(Number(result['captured']) > 0 && current.capture === capture
                              ? { capture: '' }
                              : {}),
                          }));
                          await refresh();
                        })
                      }
                    >
                      {t('roster.captureButton')}
                    </button>
                    {roleInput.captureResult && (
                      <p role="status">
                        {t('roster.captureResult', {
                          status: String(roleInput.captureResult['status']),
                          captured: count(roleInput.captureResult['captured']),
                          skipped: count(roleInput.captureResult['skipped']),
                        })}
                        {roleInput.captureResult['reason']
                          ? ` · ${String(roleInput.captureResult['reason'])}`
                          : ''}
                      </p>
                    )}
                  </details>
                  <section className="roster-overlap">
                    <h3>{t('roster.overlapTitle')}</h3>
                    <p className="field-help">{t('roster.overlapHelp')}</p>
                    <button
                      type="button"
                      className="button secondary"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          const result = await command('agent-roster.conflicts', {}, [
                            'agent-roster.conflicts',
                          ]);
                          setOverlap(entries(result['conflicts']));
                        })
                      }
                    >
                      {t('roster.checkOverlap')}
                    </button>
                    {overlap && (
                      <>
                        <p>
                          {t('shellText.rosterOverlap', {
                            count: overlap.filter(
                              (item) => item['roleA'] === selected || item['roleB'] === selected,
                            ).length,
                            role: selected,
                            total: overlap.length,
                          })}
                        </p>
                        {overlap
                          .filter(
                            (item) => item['roleA'] === selected || item['roleB'] === selected,
                          )
                          .map((item, index) => (
                            <article key={index}>
                              <header>
                                <strong>
                                  {String(item['roleA'])} ↔ {String(item['roleB'])}
                                </strong>
                                <small>
                                  {typeof item['similarity'] === 'number'
                                    ? t('roster.textOverlap', {
                                        percent: displayDecimal(item['similarity'] * 100, 0),
                                      })
                                    : t('roster.notMeasured')}
                                </small>
                              </header>
                              <blockquote>{String(item['snippetA'])}</blockquote>
                              <blockquote>{String(item['snippetB'])}</blockquote>
                              <small>
                                {t('roster.detected', {
                                  date: date(item['detectedAt']) || t('roster.notRecorded'),
                                })}
                              </small>
                            </article>
                          ))}
                      </>
                    )}
                  </section>
                  <label>
                    {t('roster.findDirective')}
                    <input
                      aria-label={t('roster.searchDirectives')}
                      value={directiveQuery}
                      onChange={(event) => setDirectiveQuery(event.target.value)}
                    />
                  </label>
                  <div className="roster-directives">
                    {entries(record(detail['agent-roster.read-learned'])['directives'])
                      .filter((entry) =>
                        `${entry['what']} ${entry['why']} ${entry['how']} ${entry['skill']}`
                          .toLowerCase()
                          .includes(directiveQuery.toLowerCase()),
                      )
                      .map((entry, index) => (
                        <details key={String(entry['key'] ?? index)}>
                          <summary>
                            <span>{String(entry['category'] ?? t('roster.directive'))}</span>
                            {String(entry['what'] ?? '')}
                          </summary>
                          <dl>
                            <dt>{t('roster.why')}</dt>
                            <dd>{String(entry['why'] ?? t('roster.notRecorded'))}</dd>
                            <dt>{t('roster.how')}</dt>
                            <dd>
                              <MarkdownContent
                                text={String(entry['how'] ?? t('roster.notRecorded'))}
                                onLink={link}
                              />
                            </dd>
                            <dt>{t('roster.skill')}</dt>
                            <dd>{String(entry['skill'] ?? t('roster.roleLevel'))}</dd>
                            <dt>{t('roster.captured')}</dt>
                            <dd>{date(entry['capturedAt']) || t('roster.notRecorded')}</dd>
                            <dt>{t('roster.applied')}</dt>
                            <dd>
                              {count(entry['applied'] ?? 0)} / {count(entry['wins'] ?? 0)}
                            </dd>
                            <dt>{t('roster.control')}</dt>
                            <dd>
                              {count(entry['skipped'] ?? 0)} / {count(entry['skippedWins'] ?? 0)}
                            </dd>
                          </dl>
                        </details>
                      ))}
                  </div>
                  <details className="roster-retired">
                    <summary>
                      {t('roster.retired', {
                        count: entries(record(detail['agent-roster.quarantine'])['retired']).length,
                      })}
                    </summary>
                    {entries(record(detail['agent-roster.quarantine'])['retired']).map(
                      (entry, index) => (
                        <article key={index}>
                          <p>{String(entry['what'] ?? '')}</p>
                          {Boolean(entry['skill']) && (
                            <small>{t('roster.skillOf', { skill: String(entry['skill']) })}</small>
                          )}
                        </article>
                      ),
                    )}
                  </details>
                </>
              )}
              {section === 'skills' && (
                <section className="roster-skill-layer">
                  <header>
                    <h3>{t('roster.skillsTitle')}</h3>
                    <p>
                      {t('roster.skillsHelp', {
                        limit: count(record(detail['agent-roster.skills'])['eagerLimit']),
                      })}
                    </p>
                  </header>
                  {entries(record(detail['agent-roster.skills'])['skills']).map((entry) => {
                    const skill = String(entry['skill']),
                      affinity = record(entry['affinity']);
                    return (
                      <article key={skill}>
                        <header>
                          <div>
                            <h4>{skill}</h4>
                            <small>
                              {entry['eager'] === true ? t('roster.eager') : t('roster.candidate')}{' '}
                              ·{' '}
                              {t('roster.score', {
                                score:
                                  typeof entry['score'] === 'number'
                                    ? displayDecimal(entry['score'], 2)
                                    : t('roster.notReported'),
                              })}
                            </small>
                          </div>
                          <span>
                            {entry['developed']
                              ? t('roster.projectAddendum')
                              : t('roster.baseSkill')}
                          </span>
                        </header>
                        {Boolean(entry['blocked']) && (
                          <p className="session-error">
                            {t('roster.loadRefused', { reason: String(entry['blocked']) })}
                          </p>
                        )}
                        <p>
                          {t('roster.affinity', {
                            learned: count(affinity['learned']),
                            loaded: count(affinity['loaded']),
                            succeeded: count(affinity['succeeded']),
                            failed: count(affinity['failed']),
                            pinned: affinity['pinned'] === true ? t('roster.yes') : t('roster.no'),
                          })}
                        </p>
                        <div>
                          <button
                            type="button"
                            className="button secondary"
                            onClick={() => setDocument({ kind: 'skill', skill })}
                          >
                            {t('roster.editAddendum')}
                          </button>
                          <button
                            type="button"
                            className="button secondary"
                            disabled={busy}
                            onClick={() =>
                              void run(async () => {
                                await command(
                                  'agent-roster.pin-skill',
                                  { role: selected, skill, pinned: affinity['pinned'] !== true },
                                  ['agent-roster.pin-skill'],
                                );
                                await refresh();
                                setNotice(
                                  affinity['pinned']
                                    ? t('roster.skillUnpinned', { skill })
                                    : t('roster.skillPinned', { skill }),
                                );
                              })
                            }
                          >
                            {affinity['pinned'] ? t('roster.unpin') : t('roster.pin')}
                          </button>
                          {entry['developed'] === true && (
                            <button
                              type="button"
                              className="button secondary danger"
                              onClick={() =>
                                setConfirmation({ action: 'clear-skill', role: selected, skill })
                              }
                            >
                              {t('roster.clearAddendum')}
                            </button>
                          )}
                        </div>
                      </article>
                    );
                  })}
                </section>
              )}
              {instruction && (
                <section
                  className="roster-prepared-instruction"
                  aria-label={t('roster.preparedLabel')}
                >
                  <h3>{t('roster.prepared')}</h3>
                  <MarkdownContent text={instruction} onLink={link} />
                  <button
                    type="button"
                    className="button secondary"
                    onClick={() =>
                      void navigator.clipboard
                        .writeText(instruction)
                        .then(() => setNotice(t('roster.instructionCopied')))
                        .catch((error) => setError(String(error)))
                    }
                  >
                    <Copy size={14} />
                    {t('roster.copyInstruction')}
                  </button>
                  <label>
                    {t('roster.conversation')}
                    <select
                      aria-label={t('roster.conversationLabel')}
                      value={targetSession}
                      onChange={(event) => setTargetSession(event.target.value)}
                    >
                      <option value="">{t('roster.chooseConversation')}</option>
                      {sessions
                        .filter((session) => session.kind === 'agent')
                        .map((session) => (
                          <option key={session.id} value={session.id}>
                            {session.title}
                          </option>
                        ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    className="button primary"
                    disabled={!targetSession}
                    onClick={() => onPrepare(targetSession, instruction)}
                  >
                    {t('roster.appendDraft')}
                  </button>
                  <button type="button" className="button secondary" onClick={onNewSession}>
                    {t('roster.newConversation')}
                  </button>
                </section>
              )}
              <footer className="roster-role-maintenance">
                <button
                  type="button"
                  className="button secondary danger"
                  disabled={busy || stats['exists'] !== true}
                  onClick={() => {
                    setConfirmation({ action: 'reset', role: selected });
                    setConfirmText('');
                  }}
                >
                  <Trash2 size={14} />
                  {t('roster.resetRole')}
                </button>
              </footer>
            </>
          )}
        </div>
      </div>
      {runtime && row && (
        <Suspense fallback={<p role="status">{t('roster.openingEditor')}</p>}>
          <RosterRuntimeEditor
            key={`${projectId}:${selected}`}
            projectId={projectId}
            role={selected}
            snapshot={customization}
            effective={effective}
            toolNames={tools}
            skillNames={skills}
            command={command}
            onClose={() => setRuntime(false)}
            onSaved={() => void refresh().catch((error) => setError(String(error)))}
          />
        </Suspense>
      )}
      {document && row && (
        <RosterDocument
          key={`${projectId}:${selected}:${document.kind}:${document.skill ?? ''}`}
          projectId={projectId}
          role={selected}
          kind={document.kind}
          skill={document.skill ?? ''}
          command={command}
          onLink={link}
          onClose={() => setDocument(null)}
          onSaved={() => void refresh().catch((error) => setError(String(error)))}
        />
      )}
      {create && (
        <Modal
          title={t('roster.createTitle')}
          onClose={() => {
            if (!busy) setCreate(false);
          }}
        >
          <form
            className="roster-create"
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                const taskTypes = createDraft.taskTypes
                  .split(/[,\n]/)
                  .map((value) => value.trim())
                  .filter(Boolean);
                if (!createDraft.name.trim() || !createDraft.purpose.trim() || !taskTypes.length)
                  throw Error(t('roster.createMissing'));
                const result = await command(
                  'agent-roster.create',
                  { ...createDraft, role: createDraft.role.trim() || undefined, taskTypes },
                  ['agent-roster.create'],
                );
                await refresh();
                setSelected(String(result['role']));
                setQuery('');
                setFilter('all');
                setSection('overview');
                setCreate(false);
                setCreateDraft({
                  name: '',
                  role: '',
                  purpose: '',
                  taskTypes: '',
                  baseRole: 'generic',
                });
                setNotice(t('roster.created'));
              });
            }}
          >
            <header>
              <h2>{t('roster.create')}</h2>
              <button
                type="button"
                className="icon-button"
                aria-label={t('roster.closeCreate')}
                disabled={busy}
                onClick={() => setCreate(false)}
              >
                <X size={18} />
              </button>
            </header>
            {createInput.notice}
            {createInput.restored && (createDraft.name || createDraft.purpose) && (
              <p className="roster-policy-note" role="status">
                {t('roster.restored')}
              </p>
            )}
            <p>{t('roster.createHelp')}</p>
            {error && (
              <p role="alert" className="session-error">
                {error}
              </p>
            )}
            {(['name', 'role', 'purpose', 'taskTypes'] as const).map((key) => (
              <label key={key} htmlFor={`${projectId}-new-role-${key}`}>
                {t(`roster.field.${key}`)}
                {key === 'purpose' || key === 'taskTypes' ? (
                  <textarea
                    id={`${projectId}-new-role-${key}`}
                    aria-label={t('roster.newRoleField', { field: key })}
                    value={createDraft[key as keyof typeof createDraft]}
                    onChange={(event) =>
                      setCreateDraft({ ...createDraft, [key]: event.target.value })
                    }
                  />
                ) : (
                  <input
                    id={`${projectId}-new-role-${key}`}
                    aria-label={t('roster.newRoleField', { field: key })}
                    value={createDraft[key as keyof typeof createDraft]}
                    onChange={(event) =>
                      setCreateDraft({ ...createDraft, [key]: event.target.value })
                    }
                  />
                )}
              </label>
            ))}
            <label>
              {t('roster.baseRole')}
              <select
                aria-label={t('roster.baseRoleLabel')}
                value={createDraft.baseRole}
                onChange={(event) =>
                  setCreateDraft({ ...createDraft, baseRole: event.target.value })
                }
              >
                {catalog.map((entry) => (
                  <option key={String(entry['role'])} value={String(entry['role'])}>
                    {String(entry['name'])} · {String(entry['role'])}
                  </option>
                ))}
              </select>
            </label>
            <footer>
              <button type="submit" className="button primary" disabled={busy}>
                {t('roster.create')}
              </button>
            </footer>
          </form>
        </Modal>
      )}
      {confirmation && (
        <Modal
          title={
            confirmation.action === 'reset'
              ? t('roster.resetAll')
              : confirmation.action === 'optimize'
                ? t('roster.confirm.optimize')
                : t('roster.confirm.clear')
          }
          onClose={() => {
            if (!busy) setConfirmation(null);
          }}
        >
          <div className="roster-confirm-dialog">
            <h2>
              {confirmation.action === 'reset'
                ? t('roster.resetAll')
                : confirmation.action === 'optimize'
                  ? t('roster.confirm.optimize')
                  : t('roster.confirm.clear')}
            </h2>
            <p>
              {confirmation.action === 'reset'
                ? confirmation.role === '*'
                  ? t('roster.confirm.resetAllBody')
                  : t('roster.confirm.resetRoleBody', { role: confirmation.role })
                : confirmation.action === 'optimize'
                  ? t('roster.confirm.optimizeBody', { role: confirmation.role })
                  : confirmation.skill
                    ? t('roster.confirm.clearSkillBody', {
                        skill: confirmation.skill,
                        role: confirmation.role,
                      })
                    : t('roster.confirm.clearBody', { role: confirmation.role })}
            </p>
            {confirmation.action === 'reset' && (
              <label>
                {t('roster.confirm.type', {
                  name: confirmation.role === '*' ? projectName : confirmation.role,
                })}
                <input
                  aria-label={t('roster.confirm.typeLabel')}
                  value={confirmText}
                  onChange={(event) => setConfirmText(event.target.value)}
                />
              </label>
            )}
            {error && (
              <p className="session-error" role="alert">
                {error}
              </p>
            )}
            <footer>
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => setConfirmation(null)}
              >
                {t('fileView.cancel')}
              </button>
              <button
                type="button"
                className="button primary"
                disabled={
                  busy ||
                  (confirmation.action === 'reset' &&
                    confirmText !== (confirmation.role === '*' ? projectName : confirmation.role))
                }
                onClick={() => void run(confirm)}
              >
                {t('roster.confirm.action')}
              </button>
            </footer>
          </div>
        </Modal>
      )}
    </section>
  );
}

function ResolvedRosterRuntime({ value }: { value: RosterRecord }) {
  const { t } = useDesktopText();
  if (!Object.keys(value).length)
    return <p className="field-help">{t('roster.runtimeUnavailable')}</p>;
  const budget = record(value['budget']),
    availability = record(value['availability']),
    policy = record(value['modelPolicy']);
  const names = (key: string) =>
    Array.isArray(value[key])
      ? value[key].join(', ') || t('roster.emptyList')
      : t('roster.noStaticList');
  return (
    <section className="roster-resolved">
      <h3>{t('roster.resolvedTitle')}</h3>
      <dl>
        {[
          [t('roster.rt.provider'), value['provider']],
          [t('roster.rt.model'), value['model']],
          [t('roster.rt.fallback'), value['fallbackProfile']],
          [t('roster.rt.cwd'), value['cwd']],
          [t('roster.rt.worktree'), value['worktree']],
        ].map(([label, value]) => (
          <div key={String(label)}>
            <dt>{String(label)}</dt>
            <dd>{value === null || value === undefined ? t('roster.inherit') : String(value)}</dd>
          </div>
        ))}
        {rosterBudgetFields.map(({ key, label }) => (
          <div key={key}>
            <dt>{t(`roster.budget.${key}`, { defaultValue: label })}</dt>
            <dd>{count(budget[key])}</dd>
          </div>
        ))}
      </dl>
      <details>
        <summary>{t('roster.toolsSummary')}</summary>
        <dl>
          <dt>{t('roster.declaredToolsLabel')}</dt>
          <dd>{names('tools')}</dd>
          <dt>{t('roster.roleSkills')}</dt>
          <dd>{names('skillNames')}</dd>
          <dt>{t('roster.capabilityRequests')}</dt>
          <dd>{names('capabilities')}</dd>
          <dt>{t('roster.allowedCapabilities')}</dt>
          <dd>{names('allowedCapabilities')}</dd>
        </dl>
      </details>
      {Object.keys(policy).length > 0 && (
        <details>
          <summary>
            {t('roster.policyTitle', {
              mode: policy['strict'] ? t('roster.enforced') : t('roster.advisory'),
            })}
          </summary>
          <p>
            {t('roster.allowed', {
              targets: entries(policy['allowed'])
                .map((target) => `${target['provider']}/${target['model']}`)
                .join(', '),
            })}
          </p>
          <p>
            {t('roster.fallbackOrder', {
              targets:
                entries(policy['fallbacks'])
                  .map((target) => `${target['provider']}/${target['model']}`)
                  .join(' → ') || t('roster.noneDeclared'),
            })}
          </p>
        </details>
      )}
      {Object.keys(availability).length > 0 && (
        <p className="roster-policy-note">
          {t('roster.availability', {
            timezone: String(availability['timezone']),
            days: Array.isArray(availability['days'])
              ? availability['days'].map((day) => t(`roster.day.${Number(day)}`)).join(', ')
              : '',
            start: String(availability['start']),
            end: String(availability['end']),
            mode: String(availability['mode']),
          })}
        </p>
      )}
    </section>
  );
}
const AUTO_REASONS = new Set([
  'disabled',
  'learning-paused',
  'too-few-entries',
  'below-threshold',
  'cooling-down',
  'size',
  'pending-skills',
]);
function AutoOptimizeStatus({ data }: { data: RosterRecord }) {
  const { t, i18n } = useDesktopText();
  const entry = entries(data['roles'])[0],
    policy = record(data['policy']);
  return entry ? (
    <section className="roster-policy-note">
      <h3>{t('roster.auto.title')}</h3>
      <p>
        {t(entry['eligible'] === true ? 'roster.auto.eligible' : 'roster.auto.waiting', {
          reason: AUTO_REASONS.has(String(entry['reason']))
            ? t(`roster.auto.reason.${String(entry['reason'])}`)
            : String(entry['reason']),
        })}
      </p>
      <small>
        {t('roster.auto.policy', {
          entries: count(policy['minEntries']),
          bytes: count(policy['thresholdBytes']),
          interval: durationText(policy['minIntervalMs'], i18n.language),
        })}
      </small>
    </section>
  ) : null;
}
