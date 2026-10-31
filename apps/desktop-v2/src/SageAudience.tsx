import { ArrowRight, Brain, Users } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { EngineCommand } from './engine-operations';
import { entries, record } from './engine-values';
export function SageAudience({
  command,
  onOpen,
}: {
  command: EngineCommand;
  onOpen: (id: string) => void;
}) {
  const [data, setData] = useState<Record<string, unknown>>({}),
    [role, setRole] = useState('all'),
    [task, setTask] = useState('all'),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const load = useCallback(
    async (cursor?: string) => {
      setBusy(true);
      setError('');
      try {
        const result = await command(
          'memory.sage.listPage',
          { statuses: ['active'], limit: 100, ...(cursor ? { cursor } : {}) },
          ['memory.sage.listPage'],
        );
        setData((current) =>
          cursor
            ? {
                ...result,
                memories: [...entries(current['memories']), ...entries(result['memories'])],
              }
            : result,
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [command],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const memories = entries(data['memories']),
    selectors = memories.map((memory) => record(memory['audience']));
  const roles = [
      ...new Set(
        selectors.flatMap((a) =>
          Array.isArray(a['roles'])
            ? a['roles'].filter((item): item is string => typeof item === 'string')
            : [],
        ),
      ),
    ],
    tasks = [
      ...new Set(
        selectors.flatMap((a) =>
          Array.isArray(a['taskTypes'])
            ? a['taskTypes'].filter((item): item is string => typeof item === 'string')
            : [],
        ),
      ),
    ];
  const rows = memories.filter((memory) => {
    const a = record(memory['audience']);
    return (
      (role === 'all' ||
        !Array.isArray(a['roles']) ||
        a['roles'].length === 0 ||
        a['roles'].includes(role)) &&
      (task === 'all' ||
        !Array.isArray(a['taskTypes']) ||
        a['taskTypes'].length === 0 ||
        a['taskTypes'].includes(task))
    );
  });
  return (
    <section className="sage-management">
      <header className="sage-page-heading">
        <div>
          <h1>Audience</h1>
          <p>
            See which project knowledge is eligible for agent roles and task types. General memories
            remain eligible for every audience.
          </p>
        </div>
        <Users size={28} />
      </header>
      {error && (
        <p className="session-error" role="alert">
          {error}
        </p>
      )}
      <div className="sage-audience-filters">
        <label>
          Agent role
          <select
            aria-label="Filter SAGE agent role"
            value={role}
            onChange={(event) => setRole(event.target.value)}
          >
            <option value="all">All roles</option>
            {roles.map((role) => (
              <option key={role} value={role}>
                {role}
              </option>
            ))}
          </select>
        </label>
        <label>
          Task type
          <select
            aria-label="Filter SAGE task type"
            value={task}
            onChange={(event) => setTask(event.target.value)}
          >
            <option value="all">All task types</option>
            {tasks.map((task) => (
              <option key={task} value={task}>
                {task}
              </option>
            ))}
          </select>
        </label>
        <span>
          {memories.length} of {String(data['total'] ?? '…')} active memories loaded
        </span>
      </div>
      <div className="sage-audience-cards">
        {rows.map((memory) => {
          const a = record(memory['audience']);
          return (
            <button
              type="button"
              key={String(memory['id'])}
              onClick={() => onOpen(String(memory['id']))}
            >
              <Brain size={17} />
              <div>
                <span>{String(memory['kind']).replaceAll('_', ' ')}</span>
                <h2>{String(memory['text'])}</h2>
                {['roles', 'taskTypes', 'modes'].map((key) => (
                  <p key={key}>
                    <strong>{key === 'taskTypes' ? 'Task types' : key}</strong>
                    {Array.isArray(a[key]) && a[key].length ? a[key].join(', ') : 'Any'}
                  </p>
                ))}
                <small>
                  {String(memory['injectionCount'] ?? 0)} injections ·{' '}
                  {String(memory['useCount'] ?? 0)} useful references
                </small>
              </div>
              <ArrowRight size={16} />
            </button>
          );
        })}
      </div>
      {typeof data['nextCursor'] === 'string' && (
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={() => void load(String(data['nextCursor']))}
        >
          Load more audience records
        </button>
      )}
      {!busy && !rows.length && (
        <p className="file-quiet-state">No active memories match this audience.</p>
      )}
    </section>
  );
}
