/** Live CodeMap telemetry: tool lifecycle, filesystem events, and agent presence. */
import { create } from 'zustand';
import type { WSCodeMapFileTarget, WSServerMessage } from '../types';

export type ActivityType =
  | 'read'
  | 'write'
  | 'edit'
  | 'delete'
  | 'search'
  | 'memory'
  | 'index'
  | 'execute';
type ActivityStatus = 'active' | 'completed' | 'failed' | 'observed';
type ActivitySource =
  | 'tool'
  | 'editor'
  | 'deterministic'
  | 'watcher'
  | 'external'
  | 'legacy';

interface ActivitySymbol {
  id: string;
  name: string;
  kind?: string | undefined;
  line?: number | undefined;
}

interface ActivityChange {
  added: number;
  removed: number;
  before?: string | undefined;
  after?: string | undefined;
}

export interface FileActivity {
  id?: string | undefined;
  toolUseId?: string | undefined;
  filePath: string;
  type: ActivityType;
  toolName: string;
  summary: string;
  timestamp: number;
  status?: ActivityStatus | undefined;
  source?: ActivitySource | undefined;
  sessionId?: string | undefined;
  traceId?: string | undefined;
  agentId?: string | undefined;
  agentName?: string | undefined;
  /** Backward-compatible display alias. */
  agent?: string | undefined;
  line?: number | undefined;
  endLine?: number | undefined;
  completedAt?: number | undefined;
  durationMs?: number | undefined;
  ok?: boolean | undefined;
  watcherConfirmed?: boolean | undefined;
  symbol?: ActivitySymbol | undefined;
  attribution?: 'exact' | 'correlated' | 'external' | undefined;
  change?: ActivityChange | undefined;
}

export interface LiveAgentPresence {
  key: string;
  agentId: string;
  agentName: string;
  sessionId: string;
  operations: FileActivity[];
  startedAt: number;
}

interface CodemapActivityState {
  history: Map<string, FileActivity[]>;
  pulses: Map<string, number>;
  activeOperations: Map<string, FileActivity[]>;
  totalCount: number;
  recordActivity: (activity: FileActivity) => void;
  startActivities: (activities: FileActivity[]) => void;
  finishTool: (
    toolUseId: string,
    completion: { timestamp?: number; durationMs?: number; ok: boolean },
  ) => void;
  recordFileEvent: (activity: FileActivity) => void;
  resolveActivitySymbol: (toolUseId: string, filePath: string, symbol: ActivitySymbol) => void;
  getActivityForFile: (filePath: string) => FileActivity[];
  getActiveForFile: (filePath: string) => FileActivity[];
  getActiveOperations: () => FileActivity[];
  getAgentPresences: () => LiveAgentPresence[];
  getPulsingFiles: () => Set<string>;
  getPulseType: (filePath: string) => ActivityType | undefined;
  clear: () => void;
  _sweep: () => void;
}

const ACTIVITY_TTL_MS = 8_000;
const CORRELATION_WINDOW_MS = 2_500;
const STALE_ACTIVE_OPERATION_MS = 30 * 60_000;
const MAX_HISTORY_PER_FILE = 200;
const MAX_TOTAL_FILES = 500;

const TOOL_TYPE_MAP: Record<string, ActivityType> = {
  read: 'read',
  read_file: 'read',
  write: 'write',
  write_file: 'write',
  edit: 'edit',
  patch: 'edit',
  apply_patch: 'edit',
  replace: 'edit',
  delete: 'delete',
  delete_file: 'delete',
  remove: 'delete',
  grep: 'search',
  glob: 'search',
  search: 'search',
  'codebase-search': 'search',
  'codebase-index': 'index',
  remember: 'memory',
  forget: 'memory',
  memory_search: 'memory',
  memory_update: 'memory',
  memory_delete: 'memory',
};

function activityTypeForOperation(operation: string, toolName = ''): ActivityType | undefined {
  if (operation === 'rename') return 'edit';
  if (operation in { read: 1, write: 1, edit: 1, delete: 1, search: 1 }) {
    return operation as ActivityType;
  }
  return TOOL_TYPE_MAP[toolName];
}

function extractPaths(input: Record<string, unknown>): string[] {
  const paths: string[] = [];
  for (const key of ['path', 'file', 'filePath', 'target']) {
    const value = input[key];
    if (typeof value === 'string') paths.push(value);
  }
  const files = input['files'];
  if (typeof files === 'string') paths.push(files);
  if (Array.isArray(files)) {
    for (const value of files) if (typeof value === 'string') paths.push(value);
  }
  return [...new Set(paths)];
}

function extractSummary(toolName: string, input: Record<string, unknown>): string {
  const oldText = typeof input['old_string'] === 'string' ? input['old_string'].trim() : '';
  const newText = typeof input['new_string'] === 'string' ? input['new_string'].trim() : '';
  if (oldText || newText) {
    const before = oldText.replace(/\s+/g, ' ').slice(0, 42) || '∅';
    const after = newText.replace(/\s+/g, ' ').slice(0, 42) || '∅';
    return `${before} → ${after}`;
  }
  if (typeof input['patch'] === 'string') {
    const change = extractChange(input);
    return `${toolName} +${change?.added ?? 0} −${change?.removed ?? 0}`;
  }
  const content = typeof input['content'] === 'string' ? input['content'] : undefined;
  if (content !== undefined) {
    const lines = content.length === 0 ? 0 : content.split(/\r?\n/).length;
    return `${toolName} ${lines} line${lines === 1 ? '' : 's'}`;
  }
  for (const key of ['query', 'pattern', 'old_string', 'new_string', 'text', 'command']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) {
      const compact = value.trim().replace(/\s+/g, ' ').slice(0, 96);
      if (key === 'query') return `"${compact}"`;
      if (key === 'pattern') return `/${compact}/`;
      if (key === 'command') return `$ ${compact}`;
      return compact;
    }
  }
  return toolName;
}

function compactChangeText(value: string): string {
  return value.trim().replace(/\s+/g, ' ').slice(0, 72);
}

function extractChange(input: Record<string, unknown>): ActivityChange | undefined {
  const oldText = typeof input['old_string'] === 'string' ? input['old_string'] : undefined;
  const newText = typeof input['new_string'] === 'string' ? input['new_string'] : undefined;
  if (oldText !== undefined || newText !== undefined) {
    const removed = oldText ? oldText.split(/\r?\n/).length : 0;
    const added = newText ? newText.split(/\r?\n/).length : 0;
    return {
      added,
      removed,
      ...(oldText ? { before: compactChangeText(oldText) } : {}),
      ...(newText ? { after: compactChangeText(newText) } : {}),
    };
  }
  const patch = typeof input['patch'] === 'string' ? input['patch'] : undefined;
  if (patch) {
    const lines = patch.split(/\r?\n/);
    const addedLines = lines.filter((line) => line.startsWith('+') && !line.startsWith('+++'));
    const removedLines = lines.filter((line) => line.startsWith('-') && !line.startsWith('---'));
    return {
      added: addedLines.length,
      removed: removedLines.length,
      ...(removedLines[0] ? { before: compactChangeText(removedLines[0].slice(1)) } : {}),
      ...(addedLines[0] ? { after: compactChangeText(addedLines[0].slice(1)) } : {}),
    };
  }
  const content = typeof input['content'] === 'string' ? input['content'] : undefined;
  if (content !== undefined) {
    return {
      added: content.length === 0 ? 0 : content.split(/\r?\n/).length,
      removed: 0,
      ...(content ? { after: compactChangeText(content) } : {}),
    };
  }
  return undefined;
}

function normalizedActivity(activity: FileActivity): FileActivity {
  const status = activity.status ?? 'observed';
  return {
    ...activity,
    id:
      activity.id ?? `${activity.toolUseId ?? 'event'}:${activity.filePath}:${activity.timestamp}`,
    status,
    source: activity.source ?? 'legacy',
    agentName: activity.agentName ?? activity.agent,
    agent: activity.agent ?? activity.agentName,
  };
}

function appendHistory(history: Map<string, FileActivity[]>, activity: FileActivity): void {
  const existing = history.get(activity.filePath) ?? [];
  history.set(activity.filePath, [activity, ...existing].slice(0, MAX_HISTORY_PER_FILE));
  if (history.size <= MAX_TOTAL_FILES) return;
  const oldest = [...history.entries()].sort(
    (a, b) => (a[1][0]?.timestamp ?? 0) - (b[1][0]?.timestamp ?? 0),
  )[0]?.[0];
  if (oldest) history.delete(oldest);
}

export function activityAgentKey(activity: FileActivity): string {
  return `${activity.sessionId ?? 'unscoped'}:${activity.agentId ?? activity.agentName ?? activity.agent ?? 'external'}`;
}

export function groupAgentPresences(operations: FileActivity[]): LiveAgentPresence[] {
  const grouped = new Map<string, LiveAgentPresence>();
  for (const operation of operations) {
    const agentId = operation.agentId ?? 'external';
    const agentName = operation.agentName ?? operation.agent ?? 'External process';
    const sessionId = operation.sessionId ?? 'unscoped';
    const key = activityAgentKey(operation);
    const existing = grouped.get(key);
    if (existing) {
      existing.operations.push(operation);
      existing.startedAt = Math.min(existing.startedAt, operation.timestamp);
    } else {
      grouped.set(key, {
        key,
        agentId,
        agentName,
        sessionId,
        operations: [operation],
        startedAt: operation.timestamp,
      });
    }
  }
  return [...grouped.values()].sort((a, b) => a.startedAt - b.startedAt);
}

function targetActivities(
  payload: Record<string, unknown>,
  targets: WSCodeMapFileTarget[],
  status: ActivityStatus,
): FileActivity[] {
  const toolName = String(payload['name'] ?? 'unknown');
  const input =
    payload['input'] && typeof payload['input'] === 'object'
      ? (payload['input'] as Record<string, unknown>)
      : {};
  const timestamp = Date.now();
  const toolUseId = String(payload['id'] ?? `${toolName}:${timestamp}`);
  const change = extractChange(input);
  const effectiveTargets: Array<{
    filePath: string;
    operation: string;
    line?: number | undefined;
    endLine?: number | undefined;
  }> = targets.length > 0 ? targets : [{ filePath: `(tool:${toolName})`, operation: 'execute' }];
  return effectiveTargets.map((target, index) => ({
    id: `${toolUseId}:${index}`,
    toolUseId,
    filePath: target.filePath,
    type:
      target.operation === 'execute'
        ? 'execute'
        : (activityTypeForOperation(target.operation, toolName) ?? 'edit'),
    toolName,
    summary: extractSummary(toolName, input),
    timestamp,
    status,
    source: 'tool',
    attribution: targets.length > 0 ? 'exact' : 'correlated',
    ...(change ? { change } : {}),
    sessionId: typeof payload['sessionId'] === 'string' ? payload['sessionId'] : undefined,
    traceId: typeof payload['traceId'] === 'string' ? payload['traceId'] : undefined,
    agentId: typeof payload['agentId'] === 'string' ? payload['agentId'] : 'leader',
    agentName: typeof payload['agentName'] === 'string' ? payload['agentName'] : 'LEADER',
    ...(target.line ? { line: target.line } : {}),
    ...(target.endLine ? { endLine: target.endLine } : {}),
  }));
}

export function extractActivitiesFromMessage(msg: WSServerMessage): FileActivity[] {
  const payload = (msg.payload ?? {}) as Record<string, unknown>;
  if (
    msg.type === 'tool.started' ||
    msg.type === 'tool.executed' ||
    msg.type === 'codemap.tool_started' ||
    msg.type === 'codemap.tool_executed'
  ) {
    const targets = Array.isArray(payload['fileTargets'])
      ? (payload['fileTargets'] as WSCodeMapFileTarget[])
      : extractPaths(
          payload['input'] && typeof payload['input'] === 'object'
            ? (payload['input'] as Record<string, unknown>)
            : {},
        ).map(
          (filePath) =>
            ({
              filePath,
              operation: TOOL_TYPE_MAP[String(payload['name'] ?? '')] ?? 'edit',
            }) as WSCodeMapFileTarget,
        );
    const started = msg.type === 'tool.started' || msg.type === 'codemap.tool_started';
    return targetActivities(payload, targets, started ? 'active' : 'completed');
  }

  // Compatibility for older servers that only exposed provider tool blocks.
  if (msg.type === 'provider.response') {
    const blocks = payload['blocks'];
    if (!Array.isArray(blocks)) return [];
    const results: FileActivity[] = [];
    for (const raw of blocks) {
      if (!raw || typeof raw !== 'object') continue;
      const block = raw as Record<string, unknown>;
      if (block['type'] !== 'tool_use') continue;
      const toolName = String(block['name'] ?? '');
      const type = TOOL_TYPE_MAP[toolName];
      if (!type) continue;
      const input =
        block['input'] && typeof block['input'] === 'object'
          ? (block['input'] as Record<string, unknown>)
          : {};
      const paths = extractPaths(input);
      const timestamp = Date.now();
      if (paths.length === 0 && (type === 'memory' || type === 'search' || type === 'index')) {
        paths.push('(global)');
      }
      for (const filePath of paths) {
        results.push({
          filePath,
          type,
          toolName,
          summary: extractSummary(toolName, input),
          timestamp,
        });
      }
    }
    return results;
  }

  if (msg.type === 'tool.progress') {
    const event =
      payload['event'] && typeof payload['event'] === 'object'
        ? (payload['event'] as Record<string, unknown>)
        : undefined;
    if (event?.['type'] !== 'file_changed' || typeof event['path'] !== 'string') return [];
    const operation = String(event['operation'] ?? 'edit');
    return [
      {
        id: `${String(payload['id'] ?? 'progress')}:${event['path']}:${Date.now()}`,
        toolUseId: typeof payload['id'] === 'string' ? payload['id'] : undefined,
        filePath: event['path'],
        type: activityTypeForOperation(operation) ?? 'edit',
        toolName: String(payload['name'] ?? 'deterministic-tool'),
        summary: String(event['text'] ?? 'tool reported file change'),
        timestamp: Date.now(),
        status: 'active',
        source: 'deterministic',
        sessionId: typeof payload['sessionId'] === 'string' ? payload['sessionId'] : undefined,
        traceId: typeof payload['traceId'] === 'string' ? payload['traceId'] : undefined,
        agentId: typeof payload['agentId'] === 'string' ? payload['agentId'] : undefined,
        agentName: typeof payload['agentName'] === 'string' ? payload['agentName'] : undefined,
        line: typeof event['line'] === 'number' ? event['line'] : undefined,
        endLine: typeof event['endLine'] === 'number' ? event['endLine'] : undefined,
        attribution: 'exact',
      },
    ];
  }

  if (msg.type === 'codemap.file_event') {
    const type = activityTypeForOperation(String(payload['operation'] ?? 'edit')) ?? 'edit';
    if (typeof payload['filePath'] !== 'string') return [];
    return [
      {
        filePath: payload['filePath'],
        type,
        toolName:
          typeof payload['toolName'] === 'string'
            ? payload['toolName']
            : String(payload['source'] ?? 'watcher'),
        summary: `${String(payload['source'] ?? 'external')} ${String(payload['operation'] ?? 'changed')}`,
        timestamp: typeof payload['at'] === 'number' ? payload['at'] : Date.now(),
        status: payload['phase'] === 'started' ? 'active' : 'observed',
        source: (payload['source'] as ActivitySource | undefined) ?? 'external',
        sessionId: typeof payload['sessionId'] === 'string' ? payload['sessionId'] : undefined,
        traceId: typeof payload['traceId'] === 'string' ? payload['traceId'] : undefined,
        agentId: typeof payload['agentId'] === 'string' ? payload['agentId'] : undefined,
        agentName: typeof payload['agentName'] === 'string' ? payload['agentName'] : undefined,
        toolUseId: typeof payload['toolUseId'] === 'string' ? payload['toolUseId'] : undefined,
        line: typeof payload['line'] === 'number' ? payload['line'] : undefined,
        endLine: typeof payload['endLine'] === 'number' ? payload['endLine'] : undefined,
      },
    ];
  }

  if (msg.type === 'file.saved' && typeof payload['filePath'] === 'string') {
    return [
      {
        filePath: payload['filePath'],
        type: 'write',
        toolName: 'save',
        summary: '',
        timestamp: Date.now(),
        source: 'editor',
      },
    ];
  }
  if (msg.type === 'memory.event' && typeof payload['event'] === 'string') {
    return [
      {
        filePath: '(memory)',
        type: 'memory',
        toolName: `memory.${payload['event']}`,
        summary: String(payload['memoryId'] ?? ''),
        timestamp: Date.now(),
      },
    ];
  }
  return [];
}

export const useCodemapActivityStore = create<CodemapActivityState>((set, get) => ({
  history: new Map(),
  pulses: new Map(),
  activeOperations: new Map(),
  totalCount: 0,

  recordActivity(raw) {
    const activity = normalizedActivity(raw);
    set((state) => {
      const history = new Map(state.history);
      const pulses = new Map(state.pulses);
      appendHistory(history, activity);
      pulses.set(activity.filePath, Date.now() + ACTIVITY_TTL_MS);
      return { history, pulses, totalCount: state.totalCount + 1 };
    });
  },

  startActivities(rawActivities) {
    if (rawActivities.length === 0) return;
    const activities = rawActivities.map((activity) =>
      normalizedActivity({ ...activity, status: 'active' }),
    );
    set((state) => {
      const history = new Map(state.history);
      const pulses = new Map(state.pulses);
      const activeOperations = new Map(state.activeOperations);
      for (const activity of activities) {
        appendHistory(history, activity);
        pulses.set(activity.filePath, Date.now() + ACTIVITY_TTL_MS);
        if (activity.toolUseId) {
          const existing = activeOperations.get(activity.toolUseId) ?? [];
          activeOperations.set(activity.toolUseId, [...existing, activity]);
        }
      }
      return {
        history,
        pulses,
        activeOperations,
        totalCount: state.totalCount + activities.length,
      };
    });
  },

  finishTool(toolUseId, completion) {
    const finishedAt = completion.timestamp ?? Date.now();
    set((state) => {
      const active = state.activeOperations.get(toolUseId) ?? [];
      if (active.length === 0) return state;
      const history = new Map(state.history);
      const pulses = new Map(state.pulses);
      for (const activity of active) {
        const entries = history.get(activity.filePath) ?? [];
        history.set(
          activity.filePath,
          entries.map((entry) =>
            entry.toolUseId === toolUseId
              ? {
                  ...entry,
                  status: completion.ok ? 'completed' : 'failed',
                  ok: completion.ok,
                  completedAt: finishedAt,
                  durationMs: completion.durationMs ?? finishedAt - entry.timestamp,
                }
              : entry,
          ),
        );
        pulses.set(activity.filePath, Date.now() + ACTIVITY_TTL_MS);
      }
      const activeOperations = new Map(state.activeOperations);
      activeOperations.delete(toolUseId);
      return { history, pulses, activeOperations };
    });
  },

  recordFileEvent(raw) {
    const activity = normalizedActivity({
      ...raw,
      attribution: raw.attribution ?? (raw.agentId ? 'exact' : 'external'),
    });
    set((state) => {
      const recent = (state.history.get(activity.filePath) ?? []).find(
        (entry) =>
          entry.source !== 'watcher' &&
          entry.source !== 'external' &&
          Math.abs(activity.timestamp - entry.timestamp) <= CORRELATION_WINDOW_MS,
      );
      if (recent) {
        const history = new Map(state.history);
        history.set(
          activity.filePath,
          (history.get(activity.filePath) ?? []).map((entry) =>
            entry.id === recent.id
              ? {
                  ...entry,
                  watcherConfirmed:
                    entry.watcherConfirmed ||
                    activity.source === 'watcher' ||
                    activity.source === 'editor',
                }
              : entry,
          ),
        );
        const pulses = new Map(state.pulses);
        pulses.set(activity.filePath, Date.now() + ACTIVITY_TTL_MS);
        return { history, pulses };
      }
      const directOwner = activity.toolUseId
        ? state.activeOperations.get(activity.toolUseId)
        : undefined;
      if (directOwner && directOwner.length > 0) {
        const owner = directOwner[0]!;
        const attributed = normalizedActivity({
          ...activity,
          status: 'active',
          source: activity.source ?? 'deterministic',
          sessionId: activity.sessionId ?? owner.sessionId,
          traceId: activity.traceId ?? owner.traceId,
          agentId: activity.agentId ?? owner.agentId,
          agentName: activity.agentName ?? owner.agentName,
          agent: activity.agent ?? owner.agent,
          attribution: 'exact',
        });
        const history = new Map(state.history);
        const pulses = new Map(state.pulses);
        const activeOperations = new Map(state.activeOperations);
        appendHistory(history, attributed);
        pulses.set(attributed.filePath, Date.now() + ACTIVITY_TTL_MS);
        activeOperations.set(activity.toolUseId!, [...directOwner, attributed]);
        return {
          history,
          pulses,
          activeOperations,
          totalCount: state.totalCount + 1,
        };
      }
      const globalCandidates = [...state.activeOperations.values()]
        .flat()
        .filter(
          (entry) =>
            entry.filePath.startsWith('(tool:') &&
            Math.abs(activity.timestamp - entry.timestamp) <= 300_000,
        );
      if (globalCandidates.length === 1) {
        const owner = globalCandidates[0]!;
        const correlated = normalizedActivity({
          ...activity,
          id: `${owner.toolUseId}:${activity.filePath}:${activity.timestamp}`,
          toolUseId: owner.toolUseId,
          toolName: owner.toolName,
          summary: `${owner.toolName} → filesystem ${activity.type}`,
          status: 'active',
          source: 'deterministic',
          sessionId: owner.sessionId,
          traceId: owner.traceId,
          agentId: owner.agentId,
          agentName: owner.agentName,
          agent: owner.agent,
          watcherConfirmed: true,
          attribution: 'correlated',
        });
        const history = new Map(state.history);
        const pulses = new Map(state.pulses);
        const activeOperations = new Map(state.activeOperations);
        appendHistory(history, correlated);
        pulses.set(correlated.filePath, Date.now() + ACTIVITY_TTL_MS);
        if (correlated.toolUseId) {
          const existing = activeOperations.get(correlated.toolUseId) ?? [];
          activeOperations.set(correlated.toolUseId, [...existing, correlated]);
        }
        return {
          history,
          pulses,
          activeOperations,
          totalCount: state.totalCount + 1,
        };
      }
      const history = new Map(state.history);
      const pulses = new Map(state.pulses);
      appendHistory(history, activity);
      pulses.set(activity.filePath, Date.now() + ACTIVITY_TTL_MS);
      return { history, pulses, totalCount: state.totalCount + 1 };
    });
  },

  resolveActivitySymbol(toolUseId, filePath, symbol) {
    set((state) => {
      const history = new Map(state.history);
      history.set(
        filePath,
        (history.get(filePath) ?? []).map((entry) =>
          entry.toolUseId === toolUseId ? { ...entry, symbol } : entry,
        ),
      );
      const activeOperations = new Map(state.activeOperations);
      const active = activeOperations.get(toolUseId);
      if (active) {
        activeOperations.set(
          toolUseId,
          active.map((entry) => (entry.filePath === filePath ? { ...entry, symbol } : entry)),
        );
      }
      return { history, activeOperations };
    });
  },

  getActivityForFile(filePath) {
    return get().history.get(filePath) ?? [];
  },
  getActiveForFile(filePath) {
    return [...get().activeOperations.values()]
      .flat()
      .filter((activity) => activity.filePath === filePath);
  },
  getActiveOperations() {
    return [...get().activeOperations.values()].flat();
  },
  getAgentPresences() {
    return groupAgentPresences(get().getActiveOperations());
  },
  getPulsingFiles() {
    get()._sweep();
    return new Set(get().pulses.keys());
  },
  getPulseType(filePath) {
    get()._sweep();
    if (!get().pulses.has(filePath)) return undefined;
    return get().history.get(filePath)?.[0]?.type;
  },
  clear() {
    set({ history: new Map(), pulses: new Map(), activeOperations: new Map(), totalCount: 0 });
  },
  _sweep() {
    const now = Date.now();
    const expiredPulses = [...get().pulses]
      .filter(([, expiry]) => expiry < now)
      .map(([filePath]) => filePath);
    const staleToolIds = [...get().activeOperations]
      .filter(([, operations]) =>
        operations.every((operation) => now - operation.timestamp > STALE_ACTIVE_OPERATION_MS),
      )
      .map(([toolUseId]) => toolUseId);
    if (expiredPulses.length === 0 && staleToolIds.length === 0) return;
    set((state) => {
      const pulses = new Map(state.pulses);
      for (const filePath of expiredPulses) pulses.delete(filePath);
      if (staleToolIds.length === 0) return { pulses };
      const history = new Map(state.history);
      const activeOperations = new Map(state.activeOperations);
      for (const toolUseId of staleToolIds) {
        for (const operation of activeOperations.get(toolUseId) ?? []) {
          history.set(
            operation.filePath,
            (history.get(operation.filePath) ?? []).map((entry) =>
              entry.toolUseId === toolUseId
                ? {
                    ...entry,
                    status: 'failed',
                    ok: false,
                    completedAt: now,
                    durationMs: now - entry.timestamp,
                    summary: `${entry.summary || entry.toolName} · telemetry timeout`,
                  }
                : entry,
            ),
          );
        }
        activeOperations.delete(toolUseId);
      }
      return { pulses, history, activeOperations };
    });
  },
}));
