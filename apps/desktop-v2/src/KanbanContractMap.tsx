import { Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand } from './engine-operations';
import { entries, record, sentenceStart } from './engine-values';
import { Modal } from './Modal';
import './kanban-contract-map.css';

export const NODE_KINDS = [
  'objective',
  'guardrail',
  'risk',
  'component',
  'artifact',
  'verification',
] as const;
export const NODE_STATES = [
  'unknown',
  'active',
  'satisfied',
  'violated',
  'waived',
  'resolved',
] as const;
export const ENFORCEMENTS = ['blocking', 'advisory', 'informational'] as const;
export const GRAPH_ENFORCEMENTS = ['off', 'advisory', 'strict'] as const;
export const EDGE_TYPES = [
  'targets',
  'affects',
  'must_preserve',
  'exposes',
  'verified_by',
  'conflicts_with',
  'derived_from',
  'relates_to',
] as const;

export interface ContractNode {
  id: string;
  taskId: string;
  kind: string;
  title: string;
  description: string;
  enforcement: string;
  state: string;
  waiver: string;
}
export interface ContractEdge {
  id: string;
  from: string;
  to: string;
  type: string;
  enforcement: string;
  rationale: string;
}
export interface ContractGraph {
  enforcement: string;
  nodes: ContractNode[];
  edges: ContractEdge[];
}

const text = (value: unknown) => (typeof value === 'string' ? value : '');

/** A board's contract graph from an engine reply; a board without one reads as off and empty. */
export function readContractGraph(value: unknown): ContractGraph {
  const graph = record(value);
  return {
    enforcement: text(graph['enforcement']) || 'off',
    nodes: entries(graph['nodes'])
      .filter((node) => typeof node['id'] === 'string' && typeof node['taskId'] === 'string')
      .map((node) => {
        const waiver = record(node['waiver']);
        return {
          id: String(node['id']),
          taskId: String(node['taskId']),
          kind: text(node['kind']),
          title: text(node['title']),
          description: text(node['description']),
          enforcement: text(node['enforcement']),
          state: text(node['state']) || 'unknown',
          waiver: waiver['reason'] ? `${text(waiver['actor'])}: ${text(waiver['reason'])}` : '',
        };
      }),
    edges: entries(graph['edges'])
      .filter((edge) => typeof edge['id'] === 'string')
      .map((edge) => ({
        id: String(edge['id']),
        from: text(edge['from']),
        to: text(edge['to']),
        type: text(edge['type']),
        enforcement: text(edge['enforcement']),
        rationale: text(edge['rationale']),
      })),
  };
}

/** The label of an edge endpoint: a node's title, or `task:<id>` as the card's title. */
export function endpointLabel(
  endpoint: string,
  nodes: readonly ContractNode[],
  tasks: readonly Record<string, unknown>[],
  kind: (value: string) => string = (value) => value,
  card: (title: string) => string = (title) => `Card: ${title}`,
): string {
  const node = nodes.find((item) => item.id === endpoint);
  if (node) return `${kind(node.kind)}: ${node.title}`;
  const taskId = endpoint.startsWith('task:') ? endpoint.slice(5) : '';
  const task = tasks.find((item) => item['id'] === taskId);
  return task ? card(String(task['title'] ?? taskId)) : endpoint;
}

/**
 * The board's contract map: what each card optimizes, must preserve and is verified by, how the
 * contracts relate, and how strictly the board enforces them when a card starts. Separate from
 * card dependencies. Every change is written by the engine and the map is read back from it.
 */
export function KanbanContractMap({
  command,
  board,
  onClose,
}: {
  command: EngineCommand;
  board: Record<string, unknown>;
  onClose: () => void;
}) {
  const { t, i18n } = useDesktopText();
  /** Engine enum values worded in the display language; unknown values stay as sent. */
  const word = (group: 'kind' | 'state' | 'enforcement' | 'edge', value: string) =>
    t(`contractMap.${group}.${value}`, { defaultValue: value.replaceAll('_', ' ') });
  const kind = (value: string) => word('kind', value);
  // The catalog words also run inside sentences ("Card: … targets objective: …"); a select
  // option stands alone, so it starts like a sentence.
  const option = (group: 'kind' | 'state' | 'enforcement' | 'edge', value: string) =>
    sentenceStart(word(group, value), i18n.language);
  const card = (title: string) => t('contractMap.card', { title });
  const boardId = String(board['id'] ?? '');
  const tasks = entries(board['tasks']).filter((task) => typeof task['id'] === 'string');
  const [graph, setGraph] = useState<ContractGraph | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [nodeDraft, setNodeDraft] = useState({
      taskId: String(tasks[0]?.['id'] ?? ''),
      kind: 'objective',
      title: '',
      enforcement: 'advisory',
    }),
    [edgeDraft, setEdgeDraft] = useState({ from: '', to: '', type: 'targets', rationale: '' }),
    [waiver, setWaiver] = useState<{ nodeId: string; actor: string; reason: string } | null>(null),
    [checkTask, setCheckTask] = useState(''),
    [check, setCheck] = useState<{ allowed: boolean; issues: string[] } | null>(null);
  const run = useCallback(
    async (type: string, payload: Record<string, unknown>) => {
      setBusy(true);
      setError('');
      try {
        const reply = await command(type, { boardId, ...payload }, [type]);
        const data = record(reply['data']);
        if ('graph' in data) setGraph(readContractGraph(data['graph']));
        return data;
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [boardId, command],
  );
  useEffect(() => {
    void run('kanban.contract.get', {});
  }, [run]);
  const taskTitle = (taskId: string) =>
    String(tasks.find((task) => task['id'] === taskId)?.['title'] ?? taskId);
  const endpoints = [
    ...(graph?.nodes ?? []).map((node) => ({
      id: node.id,
      label: `${kind(node.kind)}: ${node.title}`,
    })),
    ...tasks.map((task) => ({
      id: `task:${String(task['id'])}`,
      label: card(String(task['title'] ?? task['id'])),
    })),
  ];
  const setState = (node: ContractNode, state: string) => {
    if (state === 'waived') {
      setWaiver({ nodeId: node.id, actor: '', reason: '' });
      return;
    }
    void run('kanban.contract.node.upsert', {
      nodeId: node.id,
      taskId: node.taskId,
      kind: node.kind,
      title: node.title,
      state,
    });
  };
  return (
    <Modal title={t('contractMap.title')} onClose={() => !busy && onClose()}>
      <div className="kanban-contract-map">
        <h2>{t('contractMap.title')}</h2>
        <p className="settings-defaults-note">{t('contractMap.intro')}</p>
        {error && (
          <p role="alert" className="session-error">
            {error}
          </p>
        )}
        {!graph ? (
          <p role="status">{t('contractMap.reading')}</p>
        ) : (
          <>
            <label className="kanban-contract-enforcement">
              {t('contractMap.boardEnforcement')}
              <select
                value={graph.enforcement}
                disabled={busy}
                onChange={(event) =>
                  void run('kanban.contract.configure', { enforcement: event.target.value })
                }
              >
                {GRAPH_ENFORCEMENTS.map((value) => (
                  <option key={value} value={value}>
                    {t(`contractMap.graph.${value}`)}
                  </option>
                ))}
              </select>
            </label>
            <section aria-label={t('contractMap.byCard')}>
              <h3>{t('contractMap.contracts')}</h3>
              {!graph.nodes.length && <p className="field-help">{t('contractMap.noContracts')}</p>}
              {tasks
                .filter((task) => graph.nodes.some((node) => node.taskId === task['id']))
                .map((task) => (
                  <div key={String(task['id'])} className="kanban-contract-task">
                    <h4>{String(task['title'] ?? task['id'])}</h4>
                    <ul>
                      {graph.nodes
                        .filter((node) => node.taskId === task['id'])
                        .map((node) => (
                          <li key={node.id}>
                            <span className="kanban-contract-kind">{kind(node.kind)}</span>
                            <span>
                              {node.title}
                              <small>
                                {' '}
                                · {word('enforcement', node.enforcement)}
                                {node.waiver
                                  ? t('contractMap.waivedBy', { waiver: node.waiver })
                                  : ''}
                              </small>
                            </span>
                            <select
                              aria-label={t('contractMap.stateOf', { title: node.title })}
                              value={node.state}
                              disabled={busy}
                              onChange={(event) => setState(node, event.target.value)}
                            >
                              {NODE_STATES.map((state) => (
                                <option key={state} value={state}>
                                  {option('state', state)}
                                </option>
                              ))}
                            </select>
                            <button
                              type="button"
                              className="icon-button danger"
                              aria-label={t('contractMap.removeContract', { title: node.title })}
                              disabled={busy}
                              onClick={() =>
                                void run('kanban.contract.node.remove', { nodeId: node.id })
                              }
                            >
                              <Trash2 size={13} />
                            </button>
                          </li>
                        ))}
                    </ul>
                  </div>
                ))}
              {waiver && (
                <form
                  className="kanban-contract-form"
                  aria-label={t('contractMap.waiveLabel')}
                  onSubmit={(event) => {
                    event.preventDefault();
                    const node = graph.nodes.find((item) => item.id === waiver.nodeId);
                    if (!node) return;
                    void run('kanban.contract.node.upsert', {
                      nodeId: node.id,
                      taskId: node.taskId,
                      kind: node.kind,
                      title: node.title,
                      state: 'waived',
                      waiverActor: waiver.actor.trim(),
                      waiverReason: waiver.reason.trim(),
                    }).then((data) => data && setWaiver(null));
                  }}
                >
                  <strong>
                    {t('contractMap.waiveTitle', {
                      title: graph.nodes.find((n) => n.id === waiver.nodeId)?.title ?? '',
                    })}
                  </strong>
                  <label>
                    {t('contractMap.waivedByField')}
                    <input
                      value={waiver.actor}
                      onChange={(event) => setWaiver({ ...waiver, actor: event.target.value })}
                    />
                  </label>
                  <label>
                    {t('contractMap.reason')}
                    <input
                      value={waiver.reason}
                      onChange={(event) => setWaiver({ ...waiver, reason: event.target.value })}
                    />
                  </label>
                  <div>
                    <button
                      type="submit"
                      className="button primary small"
                      disabled={busy || !waiver.actor.trim() || !waiver.reason.trim()}
                    >
                      {t('contractMap.waive')}
                    </button>
                    <button
                      type="button"
                      className="button secondary small"
                      onClick={() => setWaiver(null)}
                    >
                      {t('contractMap.cancel')}
                    </button>
                  </div>
                </form>
              )}
              {tasks.length > 0 && (
                <form
                  className="kanban-contract-form"
                  aria-label={t('contractMap.addContract')}
                  onSubmit={(event) => {
                    event.preventDefault();
                    void run('kanban.contract.node.upsert', {
                      ...nodeDraft,
                      title: nodeDraft.title.trim(),
                    }).then((data) => data && setNodeDraft({ ...nodeDraft, title: '' }));
                  }}
                >
                  <label>
                    {t('contractMap.cardField')}
                    <select
                      value={nodeDraft.taskId}
                      onChange={(event) =>
                        setNodeDraft({ ...nodeDraft, taskId: event.target.value })
                      }
                    >
                      {tasks.map((task) => (
                        <option key={String(task['id'])} value={String(task['id'])}>
                          {String(task['title'] ?? task['id'])}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    {t('contractMap.kindField')}
                    <select
                      value={nodeDraft.kind}
                      onChange={(event) => setNodeDraft({ ...nodeDraft, kind: event.target.value })}
                    >
                      {NODE_KINDS.map((value) => (
                        <option key={value} value={value}>
                          {option('kind', value)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    {t('contractMap.enforcementField')}
                    <select
                      value={nodeDraft.enforcement}
                      onChange={(event) =>
                        setNodeDraft({ ...nodeDraft, enforcement: event.target.value })
                      }
                    >
                      {ENFORCEMENTS.map((value) => (
                        <option key={value} value={value}>
                          {option('enforcement', value)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="kanban-contract-wide">
                    {t('contractMap.contractField')}
                    <input
                      value={nodeDraft.title}
                      placeholder={t('contractMap.contractPlaceholder')}
                      onChange={(event) =>
                        setNodeDraft({ ...nodeDraft, title: event.target.value })
                      }
                    />
                  </label>
                  <button
                    type="submit"
                    className="button secondary small"
                    disabled={busy || !nodeDraft.taskId || !nodeDraft.title.trim()}
                  >
                    <Plus size={13} /> {t('contractMap.addContract')}
                  </button>
                </form>
              )}
            </section>
            <section aria-label={t('contractMap.relations')}>
              <h3>{t('contractMap.relationsTitle')}</h3>
              {!graph.edges.length && <p className="field-help">{t('contractMap.noRelations')}</p>}
              <ul className="kanban-contract-edges">
                {graph.edges.map((edge) => (
                  <li key={edge.id}>
                    <span>
                      {endpointLabel(edge.from, graph.nodes, tasks, kind, card)}{' '}
                      <strong>{word('edge', edge.type)}</strong>{' '}
                      {endpointLabel(edge.to, graph.nodes, tasks, kind, card)}
                      {edge.rationale && <small> · {edge.rationale}</small>}
                    </span>
                    <button
                      type="button"
                      className="icon-button danger"
                      aria-label={t('contractMap.removeRelation', { type: edge.type })}
                      disabled={busy}
                      onClick={() => void run('kanban.contract.edge.remove', { edgeId: edge.id })}
                    >
                      <Trash2 size={13} />
                    </button>
                  </li>
                ))}
              </ul>
              {endpoints.length > 1 && (
                <form
                  className="kanban-contract-form"
                  aria-label={t('contractMap.addRelation')}
                  onSubmit={(event) => {
                    event.preventDefault();
                    void run('kanban.contract.edge.add', {
                      from: edgeDraft.from,
                      to: edgeDraft.to,
                      edgeType: edgeDraft.type,
                      ...(edgeDraft.rationale.trim()
                        ? { rationale: edgeDraft.rationale.trim() }
                        : {}),
                    }).then(
                      (data) =>
                        data && setEdgeDraft({ ...edgeDraft, from: '', to: '', rationale: '' }),
                    );
                  }}
                >
                  {(['from', 'to'] as const).map((side) => (
                    <label key={side}>
                      {side === 'from' ? t('contractMap.from') : t('contractMap.to')}
                      <select
                        value={edgeDraft[side]}
                        onChange={(event) =>
                          setEdgeDraft({ ...edgeDraft, [side]: event.target.value })
                        }
                      >
                        <option value="">{t('contractMap.choose')}</option>
                        {endpoints.map((endpoint) => (
                          <option key={endpoint.id} value={endpoint.id}>
                            {endpoint.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
                  <label>
                    {t('contractMap.relationField')}
                    <select
                      value={edgeDraft.type}
                      onChange={(event) => setEdgeDraft({ ...edgeDraft, type: event.target.value })}
                    >
                      {EDGE_TYPES.map((type) => (
                        <option key={type} value={type}>
                          {option('edge', type)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="kanban-contract-wide">
                    {t('contractMap.why')}
                    <input
                      value={edgeDraft.rationale}
                      onChange={(event) =>
                        setEdgeDraft({ ...edgeDraft, rationale: event.target.value })
                      }
                    />
                  </label>
                  <button
                    type="submit"
                    className="button secondary small"
                    disabled={
                      busy || !edgeDraft.from || !edgeDraft.to || edgeDraft.from === edgeDraft.to
                    }
                  >
                    <Plus size={13} /> {t('contractMap.addRelation')}
                  </button>
                </form>
              )}
            </section>
            {tasks.length > 0 && (
              <section aria-label={t('contractMap.checkCard')}>
                <h3>{t('contractMap.checkCard')}</h3>
                <div className="kanban-contract-check">
                  <select
                    aria-label={t('contractMap.cardToCheck')}
                    value={checkTask}
                    onChange={(event) => {
                      setCheckTask(event.target.value);
                      setCheck(null);
                    }}
                  >
                    <option value="">{t('contractMap.chooseCard')}</option>
                    {tasks.map((task) => (
                      <option key={String(task['id'])} value={String(task['id'])}>
                        {String(task['title'] ?? task['id'])}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="button secondary small"
                    disabled={busy || !checkTask}
                    onClick={() =>
                      void run('kanban.contract.get', { taskId: checkTask }).then((data) => {
                        if (!data) return;
                        const evaluation = record(data['evaluation']);
                        setCheck({
                          allowed: evaluation['allowed'] === true,
                          issues: entries(evaluation['issues']).map((issue) =>
                            text(issue['message']),
                          ),
                        });
                      })
                    }
                  >
                    {t('contractMap.check')}
                  </button>
                </div>
                {check && (
                  <div role="status">
                    <p>
                      {check.allowed
                        ? t('contractMap.allowed', { title: taskTitle(checkTask) })
                        : t('contractMap.blocked', { title: taskTitle(checkTask) })}
                    </p>
                    {check.issues.length > 0 && (
                      <ul>
                        {check.issues.map((issue, index) => (
                          <li key={index}>{issue}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </section>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
