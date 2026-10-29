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
import type { EngineCommand } from './engine-operations';
import { entries, record } from './engine-values';
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

const RosterRuntimeEditor = lazy(() =>
  import('./RosterRuntimeEditor').then((module) => ({ default: module.RosterRuntimeEditor })),
);
const RosterInheritance = lazy(() =>
  import('./RosterInheritance').then((module) => ({ default: module.RosterInheritance })),
);
const string = (value: unknown) => (typeof value === 'string' ? value : '');
const count = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString() : '—';
const date = (value: unknown) => {
  const parsed = new Date(typeof value === 'number' ? value : String(value));
  return Number.isNaN(parsed.getTime()) ? 'Not recorded' : parsed.toLocaleString();
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
        throw Error('Type the exact project or role name to confirm.');
      const reply = await command('agent-roster.reset', { role: action.role }, [
        'agent-roster.reset',
      ]);
      await refresh();
      setNotice(
        `Removed ${Array.isArray(reply['removed']) ? reply['removed'].length : 0} project role directories. Shared and bundled definitions remain available.`,
      );
      if (action.role === '*' || action.role === selected) setSelected('');
    } else if (action.action === 'clear-consolidated') {
      await command('agent-roster.clear-consolidated', { role: action.role }, [
        'agent-roster.clear-consolidated',
      ]);
      const readback = await command('agent-roster.read-consolidated', { role: action.role }, [
        'agent-roster.read-consolidated',
      ]);
      if (readback['content'])
        throw Error('The consolidated document is still present. Refresh before retrying.');
      await refresh();
      setNotice('Project consolidated knowledge cleared.');
    } else if (action.action === 'clear-skill') {
      await command('agent-roster.clear-skill', { role: action.role, skill: action.skill }, [
        'agent-roster.clear-skill',
      ]);
      const readback = await command(
        'agent-roster.read-skill',
        { role: action.role, skill: action.skill },
        ['agent-roster.read-skill'],
      );
      if (readback['content']) throw Error('The project skill addendum is still present.');
      await refresh();
      setNotice('Project skill addendum cleared.');
    } else {
      const reply = await command('agent-roster.consolidate', { role: action.role }, [
        'agent-roster.consolidate',
      ]);
      await refresh();
      if (reply['consolidated'] === true)
        setNotice(
          `Optimized ${Number(reply['rawEntryCount'] ?? 0)} buffered directives using ${String(reply['model'] ?? 'the configured model')}. ${Array.isArray(reply['skills']) ? reply['skills'].length : 0} skill addenda updated${reply['pruned'] === true ? '; the consumed buffer was archived' : ''}.`,
        );
      else if (typeof reply['instruction'] === 'string') {
        setInstruction(reply['instruction']);
        setNotice('A consolidation instruction is ready for an existing conversation draft.');
      } else
        setNotice(
          reply['emptySynthesis'] === true
            ? 'The model returned no usable synthesis. Existing knowledge was retained.'
            : 'No pending directives to optimize. Existing consolidated knowledge was retained.',
        );
    }
    setConfirmation(null);
    setConfirmText('');
  };
  return (
    <section className="project-agent-roster" aria-label="Project agent roster">
      <header className="roster-hero">
        <div>
          <span className="eyebrow">PROJECT AGENTS · {projectName}</span>
          <h1>
            Agent roster<span className="heading-dot">.</span>
          </h1>
          <p>
            Role identities, project runtime policy and accumulated learning. This catalog describes
            agents available to the engine.
          </p>
        </div>
        <div>
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={() => void run(refresh)}
          >
            <RefreshCw size={14} />
            Refresh roster
          </button>
          <button type="button" className="button primary" onClick={() => setCreate(true)}>
            <Plus size={14} />
            Create project role
          </button>
        </div>
      </header>
      <div className="roster-summary">
        <span>
          <Users size={17} />
          <strong>{loaded ? catalog.length : '—'}</strong>roles
        </span>
        <span>
          <GitFork size={17} />
          <strong>{catalog.filter((entry) => entry['custom'] === true).length}</strong>
          project-created
        </span>
        <span>
          <Brain size={17} />
          <strong>
            {catalog
              .reduce((sum, entry) => sum + Number(record(entry['stats'])['entryCount'] ?? 0), 0)
              .toLocaleString()}
          </strong>
          recorded directives
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
          Reset project roster files
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
          <p>Another window saved different unsent role notes for this project.</p>
          <button
            type="button"
            className="button secondary"
            onClick={() => void inputStore.resolve('local')}
          >
            Keep this window’s notes
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
            Use saved notes
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
            Find a role
            <input
              aria-label="Search project agent roles"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setVisible(100);
              }}
              placeholder="Name, purpose, task type…"
            />
          </label>
          <label>
            Catalog
            <select
              aria-label="Agent role filter"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            >
              <option value="all">All roles</option>
              <option value="builtin">Built-in</option>
              <option value="custom">Project-created</option>
              <option value="modified">With project files</option>
            </select>
          </label>
          {!loaded ? (
            <p role="status">
              <LoaderCircle className="spin" size={16} />
              Loading actual roster…
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
                        ? 'Project role'
                        : entry['systemProtected']
                          ? 'Built-in'
                          : 'Project data role'}
                    </small>
                  </span>
                  <code>{String(entry['role'])}</code>
                  <p>{String(entry['summary'] ?? '')}</p>
                  <footer>
                    <span>{Number(entry['tools'] ?? 0)} declared tools</span>
                    <span>{count(record(entry['stats'])['entryCount'])} directives</span>
                  </footer>
                </button>
              ))}
              {shown.length > visible && (
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => setVisible(visible + 100)}
                >
                  Show more roles ({shown.length - visible})
                </button>
              )}
            </>
          ) : (
            <p>No matching roles.</p>
          )}
        </aside>
        <div className="roster-inspector">
          {!row ? (
            <div className="roster-empty">
              <Users size={36} />
              <h2>Choose a role to inspect.</h2>
              <p>
                Identity documents, runtime overrides, learning evidence and skill addenda stay
                attached to this project role.
              </p>
            </div>
          ) : (
            <>
              <header className="roster-role-header">
                <div>
                  <span className="eyebrow">
                    {row['systemProtected'] ? 'BUILT-IN ROLE' : 'PROJECT ROLE'} · {selected}
                  </span>
                  <h2>{String(row['name'] ?? selected)}</h2>
                  <p>{String(row['summary'] ?? '')}</p>
                  {Boolean(row['baseRole']) && <small>Based on {String(row['baseRole'])}</small>}
                </div>
                <button
                  type="button"
                  className="button secondary small"
                  onClick={() => setGraph(!graph)}
                >
                  <GitFork size={14} />
                  {graph ? 'Hide inheritance' : 'Inheritance map'}
                </button>
              </header>
              {graph && (
                <Suspense fallback={<p>Opening inheritance map…</p>}>
                  <RosterInheritance catalog={catalog} selected={selected} onSelect={setSelected} />
                </Suspense>
              )}
              <nav className="roster-sections" aria-label="Agent role sections">
                {(['overview', 'learning', 'skills'] as const).map((id) => (
                  <button
                    type="button"
                    key={id}
                    aria-current={section === id ? 'page' : undefined}
                    onClick={() => setSection(id)}
                  >
                    {id === 'overview'
                      ? 'Identity & runtime'
                      : id === 'learning'
                        ? 'Learning & evidence'
                        : 'Skill layer'}
                  </button>
                ))}
              </nav>
              {detailLoading && (
                <p role="status">
                  <LoaderCircle className="spin" size={14} />
                  Reading {selected}…
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
                      Read identity
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
                      Edit runtime policy
                    </button>
                    <button
                      type="button"
                      className="button secondary"
                      onClick={() => onOpenFile(`.wrongstack/agents/${selected}/config.json`)}
                    >
                      <FileCode2 size={14} />
                      Project config file
                    </button>
                  </div>
                  {customization['configState'] === 'unreadable' && (
                    <p className="session-error" role="alert">
                      The project config file is invalid or unreadable. Its content is preserved.
                      Repair the file and refresh before editing runtime policy.
                    </p>
                  )}
                  <section className="roster-facts">
                    <h3>Project documents</h3>
                    <dl>
                      <dt>Local identity</dt>
                      <dd>
                        {stats['hasIdentity'] === true
                          ? 'Present'
                          : stats['hasIdentity'] === false
                            ? 'Not stored'
                            : 'Not reported'}
                      </dd>
                      <dt>Runtime config</dt>
                      <dd>{String(customization['configState'] ?? 'Loading')}</dd>
                      <dt>Knowledge checklist</dt>
                      <dd>{stats['hasKnowledge'] === true ? 'Present' : 'Not stored'}</dd>
                      <dt>Last learning capture</dt>
                      <dd>{date(stats['lastCapture'])}</dd>
                      <dt>Task types</dt>
                      <dd>
                        {Array.isArray(row['taskTypes']) && row['taskTypes'].length
                          ? row['taskTypes'].join(', ')
                          : 'Catalog default'}
                      </dd>
                    </dl>
                  </section>
                  <ResolvedRosterRuntime value={effective} />
                  <section className="roster-improve">
                    <h3>Ask for a focused improvement</h3>
                    <p>
                      Prepare an instruction for an existing conversation's leader to improve this
                      project's role files.
                    </p>
                    <textarea
                      aria-label="Role improvement request"
                      value={improve}
                      onChange={(event) => setImprove(event.target.value)}
                      placeholder="Describe the behavior or knowledge to improve…"
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
                            throw Error('The engine did not return an improvement instruction.');
                          setInstruction(reply['instruction']);
                        })
                      }
                    >
                      <Sparkles size={14} />
                      Prepare improvement
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
                      ['Directives', stats['entryCount']],
                      ['Buffer bytes', stats['totalBytes']],
                      ['Lifetime captures', stats['lifetimeCaptureCount']],
                      ['Applied directives', stats['appliedEntryCount']],
                      ['Not exercised', stats['deadEntryCount']],
                      ['Measured against control', stats['measuredEntryCount']],
                    ].map(([label, value]) => (
                      <div key={String(label)}>
                        <strong>{count(value)}</strong>
                        <span>{String(label)}</span>
                      </div>
                    ))}
                  </div>
                  <p className="roster-policy-note">
                    Directive lift:{' '}
                    {typeof stats['directiveLift'] === 'number'
                      ? stats['directiveLift'].toFixed(3)
                      : 'Not enough controlled evidence'}
                    . Raw task success rate:{' '}
                    {typeof stats['directiveHitRate'] === 'number'
                      ? `${(stats['directiveHitRate'] * 100).toFixed(1)}%`
                      : 'Not measured'}
                    ; it does not establish that the directives caused success.
                  </p>
                  <div className="roster-role-actions">
                    <button
                      type="button"
                      className="button secondary"
                      onClick={() => setDocument({ kind: 'learned' })}
                    >
                      <Pencil size={14} />
                      Read / edit directives
                    </button>
                    <button
                      type="button"
                      className="button secondary"
                      onClick={() => setDocument({ kind: 'consolidated' })}
                    >
                      <BookOpen size={14} />
                      Consolidated knowledge
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
                            throw Error(
                              'The learning policy changed elsewhere. Refresh before changing it.',
                            );
                          await command(
                            'agent-roster.update-learning',
                            { role: selected, enabled: !stats['learningEnabled'] },
                            ['agent-roster.update-learning'],
                          );
                          await refresh();
                          setNotice(
                            stats['learningEnabled']
                              ? 'Learning paused; existing project knowledge is retained.'
                              : 'Learning enabled for this role.',
                          );
                        })
                      }
                    >
                      {stats['learningEnabled'] === true ? 'Pause learning' : 'Enable learning'}
                    </button>
                    <button
                      type="button"
                      className="button secondary"
                      disabled={busy}
                      onClick={() => setConfirmation({ action: 'optimize', role: selected })}
                    >
                      <Sparkles size={14} />
                      Optimize learning
                    </button>
                    {stats['isConsolidated'] === true && (
                      <button
                        type="button"
                        className="button secondary danger"
                        onClick={() =>
                          setConfirmation({ action: 'clear-consolidated', role: selected })
                        }
                      >
                        Clear consolidated document
                      </button>
                    )}
                  </div>
                  <section className="roster-teach">
                    <h3>Teach a project instruction</h3>
                    <p>
                      Add a narrowly scoped convention, pattern, warning or fact. The engine
                      deduplicates and structures the buffer.
                    </p>
                    <textarea
                      aria-label="Teach role instruction"
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
                          setNotice(
                            'Project directive document updated. Inspect the stored directives below.',
                          );
                        })
                      }
                    >
                      <Plus size={14} />
                      Add project instruction
                    </button>
                  </section>
                  <AutoOptimizeStatus data={record(detail['agent-roster.auto-optimize-status'])} />
                  <section className="roster-facts">
                    <h3>Capture and consolidation record</h3>
                    <dl>
                      <dt>Last capture</dt>
                      <dd>
                        {date(stats['lastCapture'])} ·{' '}
                        {String(stats['lastCaptureSource'] ?? 'Not recorded')}
                      </dd>
                      <dt>Capture window</dt>
                      <dd>
                        {count(stats['sessionCaptureCount'])} captures · cooldown{' '}
                        {typeof stats['cooldownRemainingMs'] === 'number'
                          ? `${Math.ceil(stats['cooldownRemainingMs'] / 1000)} s`
                          : 'Not reported'}
                      </dd>
                      <dt>Routed to skills</dt>
                      <dd>{count(stats['skilledEntryCount'])} directives</dd>
                      <dt>Consolidation recommendation</dt>
                      <dd>
                        {stats['needsSummarization'] === true
                          ? 'Buffer is ready for consolidation review'
                          : stats['needsSummarization'] === false
                            ? 'No buffer-size recommendation'
                            : 'Not reported'}
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
                            <dt>
                              {
                                (
                                  {
                                    consolidatedAt: 'Consolidated',
                                    sourceEntryCount: 'Buffer entries after consolidation',
                                    sourceBytes: 'Buffer bytes after consolidation',
                                    consolidatedBytes: 'Stored bytes',
                                    trigger: 'Trigger',
                                    model: 'Model',
                                    pruned: 'Consumed buffer archived',
                                  } as Record<string, string>
                                )[name]
                              }
                            </dt>
                            <dd>
                              {name === 'consolidatedAt'
                                ? date(value)
                                : typeof value === 'boolean'
                                  ? value
                                    ? 'Yes'
                                    : 'No'
                                  : String(value)}
                            </dd>
                          </div>
                        ))}
                    </dl>
                  </section>
                  <details className="roster-capture">
                    <summary>Capture instructions from agent output</summary>
                    <p className="field-help">
                      Paste output containing a LEARNED section. The engine reports captures,
                      skipped entries and quality refusals.
                    </p>
                    <textarea
                      aria-label="Role capture output"
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
                      Capture project instructions
                    </button>
                    {roleInput.captureResult && (
                      <p role="status">
                        {String(roleInput.captureResult['status'])} · captured{' '}
                        {count(roleInput.captureResult['captured'])}, skipped{' '}
                        {count(roleInput.captureResult['skipped'])}
                        {roleInput.captureResult['reason']
                          ? ` · ${String(roleInput.captureResult['reason'])}`
                          : ''}
                      </p>
                    )}
                  </details>
                  <section className="roster-overlap">
                    <h3>Directive overlap</h3>
                    <p className="field-help">
                      Compare stored directives across this project's roles. Text similarity
                      identifies review candidates; it does not establish a contradiction.
                    </p>
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
                      Check project directive overlap
                    </button>
                    {overlap && (
                      <>
                        <p>
                          {
                            overlap.filter(
                              (item) => item['roleA'] === selected || item['roleB'] === selected,
                            ).length
                          }{' '}
                          candidates involving {selected}; {overlap.length} in the project.
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
                                    ? `${(item['similarity'] * 100).toFixed(0)}% text overlap`
                                    : 'Not measured'}
                                </small>
                              </header>
                              <blockquote>{String(item['snippetA'])}</blockquote>
                              <blockquote>{String(item['snippetB'])}</blockquote>
                              <small>Detected {date(item['detectedAt'])}</small>
                            </article>
                          ))}
                      </>
                    )}
                  </section>
                  <label>
                    Find a directive
                    <input
                      aria-label="Search role directives"
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
                            <span>{String(entry['category'] ?? 'Directive')}</span>
                            {String(entry['what'] ?? '')}
                          </summary>
                          <dl>
                            <dt>Why</dt>
                            <dd>{String(entry['why'] ?? 'Not recorded')}</dd>
                            <dt>How / evidence</dt>
                            <dd>
                              <MarkdownContent
                                text={String(entry['how'] ?? 'Not recorded')}
                                onLink={link}
                              />
                            </dd>
                            <dt>Skill</dt>
                            <dd>{String(entry['skill'] ?? 'Role-level')}</dd>
                            <dt>Captured</dt>
                            <dd>{date(entry['capturedAt'])}</dd>
                            <dt>Applied / successful</dt>
                            <dd>
                              {count(entry['applied'] ?? 0)} / {count(entry['wins'] ?? 0)}
                            </dd>
                            <dt>Control uses / successful</dt>
                            <dd>
                              {count(entry['skipped'] ?? 0)} / {count(entry['skippedWins'] ?? 0)}
                            </dd>
                          </dl>
                        </details>
                      ))}
                  </div>
                  <details className="roster-retired">
                    <summary>
                      Retired directives (
                      {entries(record(detail['agent-roster.quarantine'])['retired']).length})
                    </summary>
                    {entries(record(detail['agent-roster.quarantine'])['retired']).map(
                      (entry, index) => (
                        <article key={index}>
                          <p>{String(entry['what'] ?? '')}</p>
                          {Boolean(entry['skill']) && (
                            <small>Skill: {String(entry['skill'])}</small>
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
                    <h3>Role skill delivery</h3>
                    <p>
                      Ranking, project addenda and observed load failures from the engine. Eager
                      limit: {count(record(detail['agent-roster.skills'])['eagerLimit'])}.
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
                              {entry['eager'] === true ? 'Eager delivery' : 'Available candidate'} ·
                              score{' '}
                              {typeof entry['score'] === 'number'
                                ? entry['score'].toFixed(2)
                                : 'Not reported'}
                            </small>
                          </div>
                          <span>{entry['developed'] ? 'Project addendum' : 'Base skill'}</span>
                        </header>
                        {Boolean(entry['blocked']) && (
                          <p className="session-error">
                            Last load refused: {String(entry['blocked'])}
                          </p>
                        )}
                        <p>
                          Learned: {count(affinity['learned'])} · loaded:{' '}
                          {count(affinity['loaded'])} · successful / failed outcomes:{' '}
                          {count(affinity['succeeded'])} / {count(affinity['failed'])} · pinned:{' '}
                          {affinity['pinned'] === true ? 'Yes' : 'No'}
                        </p>
                        <div>
                          <button
                            type="button"
                            className="button secondary"
                            onClick={() => setDocument({ kind: 'skill', skill })}
                          >
                            Read / edit addendum
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
                                    ? `${skill} unpinned.`
                                    : `${skill} pinned for this role.`,
                                );
                              })
                            }
                          >
                            {affinity['pinned'] ? 'Unpin skill' : 'Pin skill'}
                          </button>
                          {entry['developed'] === true && (
                            <button
                              type="button"
                              className="button secondary danger"
                              onClick={() =>
                                setConfirmation({ action: 'clear-skill', role: selected, skill })
                              }
                            >
                              Clear project addendum
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
                  aria-label="Prepared role instruction"
                >
                  <h3>Prepared instruction</h3>
                  <MarkdownContent text={instruction} onLink={link} />
                  <button
                    type="button"
                    className="button secondary"
                    onClick={() =>
                      void navigator.clipboard
                        .writeText(instruction)
                        .then(() => setNotice('Instruction copied.'))
                        .catch((error) => setError(String(error)))
                    }
                  >
                    <Copy size={14} />
                    Copy instruction
                  </button>
                  <label>
                    Existing conversation
                    <select
                      aria-label="Role instruction conversation"
                      value={targetSession}
                      onChange={(event) => setTargetSession(event.target.value)}
                    >
                      <option value="">Choose a conversation</option>
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
                    Append to selected chat draft
                  </button>
                  <button type="button" className="button secondary" onClick={onNewSession}>
                    Create a conversation
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
                  Reset this role's project files
                </button>
              </footer>
            </>
          )}
        </div>
      </div>
      {runtime && row && (
        <Suspense fallback={<p role="status">Opening role runtime editor…</p>}>
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
          title="Create project roster role"
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
                  throw Error('Enter a name, purpose and at least one task type.');
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
                setNotice('Project role created and listed.');
              });
            }}
          >
            <header>
              <h2>Create project role</h2>
              <button
                type="button"
                className="icon-button"
                aria-label="Close role creation"
                disabled={busy}
                onClick={() => setCreate(false)}
              >
                <X size={18} />
              </button>
            </header>
            {createInput.notice}
            {createInput.restored && (createDraft.name || createDraft.purpose) && (
              <p className="roster-policy-note" role="status">
                Restored the role you had not created yet.
              </p>
            )}
            <p>
              The role inherits its base definition and stores its identity under this project's
              .wrongstack/agents directory.
            </p>
            {error && (
              <p role="alert" className="session-error">
                {error}
              </p>
            )}
            {[
              ['name', 'Display name'],
              ['role', 'Role key (optional)'],
              ['purpose', 'Purpose'],
              ['taskTypes', 'Task types (comma or line separated)'],
            ].map(([key, label]) => (
              <label key={key} htmlFor={`${projectId}-new-role-${key}`}>
                {label}
                {key === 'purpose' || key === 'taskTypes' ? (
                  <textarea
                    id={`${projectId}-new-role-${key}`}
                    aria-label={`New role ${key}`}
                    value={createDraft[key as keyof typeof createDraft]}
                    onChange={(event) =>
                      setCreateDraft({ ...createDraft, [key!]: event.target.value })
                    }
                  />
                ) : (
                  <input
                    id={`${projectId}-new-role-${key}`}
                    aria-label={`New role ${key}`}
                    value={createDraft[key as keyof typeof createDraft]}
                    onChange={(event) =>
                      setCreateDraft({ ...createDraft, [key!]: event.target.value })
                    }
                  />
                )}
              </label>
            ))}
            <label>
              Base role
              <select
                aria-label="New role base"
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
                Create project role
              </button>
            </footer>
          </form>
        </Modal>
      )}
      {confirmation && (
        <Modal
          title={
            confirmation.action === 'reset'
              ? 'Reset project roster files'
              : confirmation.action === 'optimize'
                ? 'Optimize role learning'
                : 'Clear project role document'
          }
          onClose={() => {
            if (!busy) setConfirmation(null);
          }}
        >
          <div className="roster-confirm-dialog">
            <h2>
              {confirmation.action === 'reset'
                ? 'Reset project roster files'
                : confirmation.action === 'optimize'
                  ? 'Optimize role learning'
                  : 'Clear project role document'}
            </h2>
            <p>
              {confirmation.action === 'reset'
                ? `Remove ${confirmation.role === '*' ? 'all role directories in this project' : `the project directory for ${confirmation.role}`}, including local identity, runtime, learning, custom-role definitions and skill addenda. Built-in and shared definitions remain.`
                : confirmation.action === 'optimize'
                  ? `Synthesize the pending directives for ${confirmation.role}, update consolidated knowledge and skill addenda, and archive the consumed buffer when the configured model succeeds.`
                  : `Clear ${confirmation.skill ? `the ${confirmation.skill} addendum` : 'the consolidated knowledge document'} for ${confirmation.role} in this project.`}
            </p>
            {confirmation.action === 'reset' && (
              <label>
                Type {confirmation.role === '*' ? projectName : confirmation.role}
                <input
                  aria-label="Confirm roster reset name"
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
                Cancel
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
                Confirm roster action
              </button>
            </footer>
          </div>
        </Modal>
      )}
    </section>
  );
}

function ResolvedRosterRuntime({ value }: { value: RosterRecord }) {
  if (!Object.keys(value).length)
    return (
      <p className="field-help">
        Resolved runtime details are unavailable on this engine. Stored project overrides remain
        distinct from catalog defaults.
      </p>
    );
  const budget = record(value['budget']),
    availability = record(value['availability']),
    policy = record(value['modelPolicy']);
  const names = (key: string) =>
    Array.isArray(value[key])
      ? value[key].join(', ') || 'Explicit empty list'
      : 'Catalog does not declare a static list';
  return (
    <section className="roster-resolved">
      <h3>Resolved runtime for the next spawn</h3>
      <dl>
        {[
          ['Provider', value['provider']],
          ['Model', value['model']],
          ['Fallback profile', value['fallbackProfile']],
          ['Working directory', value['cwd']],
          ['Checkout strategy', value['worktree']],
        ].map(([label, value]) => (
          <div key={String(label)}>
            <dt>{String(label)}</dt>
            <dd>
              {value === null || value === undefined ? 'Inherit from routing' : String(value)}
            </dd>
          </div>
        ))}
        {rosterBudgetFields.map(({ key, label }) => (
          <div key={key}>
            <dt>{label}</dt>
            <dd>{count(budget[key])}</dd>
          </div>
        ))}
      </dl>
      <details>
        <summary>Tools, skills and capabilities</summary>
        <dl>
          <dt>Declared tools</dt>
          <dd>{names('tools')}</dd>
          <dt>Role skills</dt>
          <dd>{names('skillNames')}</dd>
          <dt>Capability requests</dt>
          <dd>{names('capabilities')}</dd>
          <dt>Allowed capabilities</dt>
          <dd>{names('allowedCapabilities')}</dd>
        </dl>
      </details>
      {Object.keys(policy).length > 0 && (
        <details>
          <summary>Resolved model policy · {policy['strict'] ? 'Enforced' : 'Advisory'}</summary>
          <p>
            Allowed:{' '}
            {entries(policy['allowed'])
              .map((target) => `${target['provider']}/${target['model']}`)
              .join(', ')}
          </p>
          <p>
            Fallback order:{' '}
            {entries(policy['fallbacks'])
              .map((target) => `${target['provider']}/${target['model']}`)
              .join(' → ') || 'None declared'}
          </p>
        </details>
      )}
      {Object.keys(availability).length > 0 && (
        <p className="roster-policy-note">
          Availability: {String(availability['timezone'])},{' '}
          {Array.isArray(availability['days'])
            ? availability['days']
                .map((day) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][Number(day)])
                .join(', ')
            : ''}
          , {String(availability['start'])}–{String(availability['end'])} ·{' '}
          {String(availability['mode'])}.
        </p>
      )}
    </section>
  );
}
function AutoOptimizeStatus({ data }: { data: RosterRecord }) {
  const entry = entries(data['roles'])[0],
    policy = record(data['policy']);
  const reasons: Record<string, string> = {
    disabled: 'Automatic optimization is disabled.',
    'learning-paused': 'Learning is paused for this role.',
    'too-few-entries': 'The directive buffer has fewer entries than the configured minimum.',
    'below-threshold': 'The buffer has not reached its size or pending-skill threshold.',
    'cooling-down': 'The minimum interval has not elapsed.',
    size: 'The buffer reached its size threshold.',
    'pending-skills': 'Pending skill directives reached the configured threshold.',
  };
  return entry ? (
    <section className="roster-policy-note">
      <h3>Automatic optimization</h3>
      <p>
        {entry['eligible'] === true ? 'Eligible: ' : 'Waiting: '}
        {reasons[String(entry['reason'])] ?? String(entry['reason'])}
      </p>
      <small>
        Minimum entries: {count(policy['minEntries'])} · buffer threshold:{' '}
        {count(policy['thresholdBytes'])} bytes · interval: {count(policy['minIntervalMs'])} ms.
      </small>
    </section>
  ) : null;
}
