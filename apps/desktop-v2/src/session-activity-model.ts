import { timestampDate } from './display-dates';
import { contentText, type EngineEvent, record } from './engine-state';

export interface ActivityRow {
  id: string;
  kind: 'tool' | 'reasoning' | 'run' | 'retry';
  title: string;
  status: 'running' | 'done' | 'failed' | 'aborted' | 'info';
  input?: unknown;
  output?: string;
  progress: string[];
  files: Array<{ path: string; operation: string }>;
  sage: string[];
  durationMs?: number;
  /** First observed frame time, preferring an explicit tool start when available. */
  at?: number;
  finishedAt?: number;
  outputBytes?: number;
  agent?: string;
  /** The iteration in which this row first appeared; late tool results keep that ownership. */
  iterationId?: string;
  /**
   * The agent's own name for a call an ACP agent ran (its `title` is then the matching
   * WrongStack tool, from the event's `view`), shown as the row's tooltip.
   */
  agentTitle?: string;
  /** The MCP server of an ACP agent's MCP call. */
  server?: string;
  /** Catalog wording for run rows; `title` stays the English plain-text form. */
  label?: { key: string; values?: Record<string, string | number> };
}
/** A tool event's display view (`view`): the WrongStack tool an ACP agent's call matches. */
export function toolView(
  payload: Record<string, unknown>,
): { name: string; input: unknown; server?: string } | undefined {
  const view = record(payload['view']);
  if (typeof view['name'] !== 'string' || !view['name']) return undefined;
  return {
    name: view['name'],
    input: view['input'],
    ...(typeof view['server'] === 'string' ? { server: view['server'] } : {}),
  };
}

/** Build readable activity from engine frames and locally observed process boundaries. */
export function activityRows(events: readonly EngineEvent[]): ActivityRow[] {
  const rows: ActivityRow[] = [];
  const tools = new Map<string, ActivityRow>();
  let iteration: ActivityRow | undefined;
  let runIndex = 0;
  for (const [index, event] of events.entries()) {
    const p = event.payload;
    const at = timestampDate(event.at)?.getTime();
    const timed = at === undefined ? {} : { at };
    if (event.type === 'desktop.engine_boundary') {
      if (iteration?.status === 'running') iteration.status = 'aborted';
      iteration = undefined;
      for (const tool of tools.values()) if (tool.status === 'running') tool.status = 'aborted';
      tools.clear();
      runIndex++;
      continue;
    }
    if (
      event.type === 'tool.started' ||
      event.type === 'tool.executed' ||
      event.type === 'tool.progress'
    ) {
      const id = typeof p['id'] === 'string' ? p['id'] : `missing-${index}`;
      const agent = typeof p['agentId'] === 'string' ? p['agentId'] : '';
      const key = `${agent}:${id}`;
      let row = tools.get(key);
      if (!row) {
        row = {
          ...timed,
          id: `tool:${runIndex}:${key}`,
          kind: 'tool',
          ...(iteration ? { iterationId: iteration.id } : {}),
          title: String(p['name'] ?? 'Tool'),
          status: 'running',
          progress: [],
          files: [],
          sage: [],
        };
        rows.push(row);
        tools.set(key, row);
      }
      if (at !== undefined && (event.type === 'tool.started' || row.at === undefined)) row.at = at;
      // An ACP agent's call: shown as the WrongStack tool it matches (its `view`), the agent's
      // own title and raw input kept aside.
      const view = toolView(p);
      if (typeof p['name'] === 'string') {
        if (view && p['name'] !== view.name) row.agentTitle = p['name'];
        row.title = view?.name ?? p['name'];
      }
      if (view?.input !== undefined) row.input = view.input;
      else if (!view && p['input'] !== undefined) row.input = p['input'];
      if (view?.server) row.server = view.server;
      if (typeof p['agentName'] === 'string') row.agent = p['agentName'];
      else if (agent) row.agent = agent;
      if (Array.isArray(p['fileTargets'])) {
        for (const target of p['fileTargets']) {
          const file = record(target);
          if (
            typeof file['filePath'] === 'string' &&
            !row.files.some((entry) => entry.path === file['filePath'])
          )
            row.files.push({
              path: file['filePath'],
              operation: String(file['operation'] ?? 'open'),
            });
        }
      }
      if (event.type === 'tool.progress') {
        const progress = record(p['event']);
        const text = contentText(progress['text']);
        if (text) row.progress.push(text);
        if (
          typeof progress['path'] === 'string' &&
          !row.files.some((entry) => entry.path === progress['path'])
        )
          row.files.push({
            path: progress['path'],
            operation: String(progress['operation'] ?? 'open'),
          });
      }
      if (event.type === 'tool.executed') {
        row.status = p['ok'] === false ? 'failed' : p['ok'] === true ? 'done' : 'info';
        row.output = contentText(p['output']);
        if (typeof event.at === 'number' && !Number.isNaN(new Date(event.at).getTime()))
          row.finishedAt = event.at;
        if (typeof p['durationMs'] === 'number') row.durationMs = p['durationMs'];
        if (typeof p['outputBytes'] === 'number') row.outputBytes = p['outputBytes'];
        if (Array.isArray(p['sage']))
          row.sage = p['sage'].filter((item): item is string => typeof item === 'string');
      }
    } else if (event.type === 'provider.thinking_delta') {
      const text = contentText(p['text']);
      if (!text) continue;
      const previous = rows.at(-1);
      if (previous?.kind === 'reasoning' && previous.iterationId === iteration?.id)
        previous.output = (previous.output ?? '') + text;
      else
        rows.push({
          ...timed,
          id: `thinking:${index}`,
          kind: 'reasoning',
          ...(iteration ? { iterationId: iteration.id } : {}),
          title: 'Thinking',
          label: { key: 'runLog.thinking' },
          status: 'info',
          output: text,
          progress: [],
          files: [],
          sage: [],
        });
    } else if (event.type === 'provider.retry') {
      rows.push({
        ...timed,
        id: `retry:${index}`,
        kind: 'retry',
        ...(iteration ? { iterationId: iteration.id } : {}),
        title: `${String(p['providerId'] ?? 'Provider')} retry ${String(p['attempt'] ?? '')}`,
        label: {
          key: 'runLog.title.retry',
          values: {
            provider: String(p['providerId'] ?? 'Provider'),
            attempt: String(p['attempt'] ?? ''),
          },
        },
        status: 'info',
        output: String(p['description'] ?? ''),
        ...(typeof p['delayMs'] === 'number' ? { durationMs: p['delayMs'] } : {}),
        progress: [],
        files: [],
        sage: [],
      });
    } else if (event.type === 'iteration.started') {
      // The engine counts iterations from zero; the status bar shows the first one as 1.
      const number = typeof p['index'] === 'number' ? p['index'] + 1 : String(p['index'] ?? '');
      iteration = {
        ...timed,
        id: `iteration:${index}`,
        iterationId: `iteration:${index}`,
        kind: 'run',
        title: `Iteration ${number}`,
        label: { key: 'runLog.title.iteration', values: { number } },
        status: 'running',
        progress: [],
        files: [],
        sage: [],
      };
      rows.push(iteration);
    } else if (event.type === 'iteration.completed') {
      if (iteration) iteration.status = 'done';
      iteration = undefined;
    } else if (event.type === 'run.result') {
      const status =
        p['status'] === 'done'
          ? 'done'
          : p['status'] === 'aborted'
            ? 'aborted'
            : p['status'] === 'failed'
              ? 'failed'
              : 'info';
      if (iteration?.status === 'running') iteration.status = status;
      iteration = undefined;
      const message = record(p['error'])['message'];
      const outcome =
        p['status'] === 'max_iterations'
          ? 'limit'
          : status === 'done'
            ? 'completed'
            : status === 'aborted'
              ? 'stopped'
              : 'ended';
      rows.push({
        ...timed,
        id: `result:${index}`,
        kind: 'run',
        label: { key: `runLog.title.${outcome}` },
        title:
          p['status'] === 'max_iterations'
            ? 'Iteration limit reached'
            : status === 'done'
              ? 'Run completed'
              : status === 'aborted'
                ? 'Run stopped'
                : 'Run ended',
        status,
        ...(typeof message === 'string' ? { output: message } : {}),
        progress: [],
        files: [],
        sage: [],
      });
      // An interrupted run may close without a final frame for its in-flight tools.
      for (const tool of tools.values()) {
        if (tool.status === 'running') tool.status = status === 'done' ? 'info' : status;
      }
      tools.clear();
      runIndex++;
    }
  }
  return rows;
}
