import type {
  ActivityChange,
  ActivitySource,
  ActivityStatus,
  ActivityType,
  FileActivity,
} from './codemap-activity-types.js';

/** A file a tool touches, as the engine reports it on tool frames (`fileTargets`). */
interface WSCodeMapFileTarget {
  filePath: string;
  operation: 'read' | 'write' | 'edit' | 'delete' | 'search';
  line?: number | undefined;
  endLine?: number | undefined;
}

/** Any engine frame: only its type and payload are read. */
interface ActivityFrame {
  type: string;
  payload?: unknown;
}

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
    // A `--- `/`+++ ` pair is a file header only OUTSIDE a hunk body: the
    // hunk-declared line counts tell it apart from header-shaped content such
    // as a removed `--- rule one` followed by an added `+++ rule two`. The
    // same rule core's countUnifiedDiffLines enforces.
    const lines = patch.split(/\r?\n/);
    let added = 0;
    let removed = 0;
    let before: string | undefined;
    let after: string | undefined;
    let sawHunk = false;
    let oldRemaining = 0;
    let newRemaining = 0;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? '';
      if (line.startsWith('@@')) {
        sawHunk = true;
        const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
        oldRemaining = hunk ? Number(hunk[1] ?? 1) : 0;
        newRemaining = hunk ? Number(hunk[2] ?? 1) : 0;
        continue;
      }
      if (line.startsWith('diff --git ')) {
        oldRemaining = 0;
        newRemaining = 0;
        continue;
      }
      if (!sawHunk) continue;
      if (
        oldRemaining <= 0 &&
        newRemaining <= 0 &&
        line.startsWith('--- ') &&
        lines[index + 1]?.startsWith('+++ ')
      ) {
        index += 1;
        continue;
      }
      if (line.startsWith('+')) {
        added += 1;
        newRemaining -= 1;
        after ??= line.slice(1);
      } else if (line.startsWith('-')) {
        removed += 1;
        oldRemaining -= 1;
        before ??= line.slice(1);
      } else if (line.startsWith(' ')) {
        oldRemaining -= 1;
        newRemaining -= 1;
      }
    }
    return {
      added,
      removed,
      ...(before !== undefined ? { before: compactChangeText(before) } : {}),
      ...(after !== undefined ? { after: compactChangeText(after) } : {}),
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

export function extractActivitiesFromMessage(msg: ActivityFrame): FileActivity[] {
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
