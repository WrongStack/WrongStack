export type ActivityType =
  | 'read'
  | 'write'
  | 'edit'
  | 'delete'
  | 'search'
  | 'memory'
  | 'index'
  | 'execute';

export type ActivityStatus = 'active' | 'completed' | 'failed' | 'observed';

export type ActivitySource =
  | 'tool'
  | 'editor'
  | 'deterministic'
  | 'watcher'
  | 'external'
  | 'legacy';

export interface ActivitySymbol {
  id: string;
  name: string;
  kind?: string | undefined;
  line?: number | undefined;
}

export interface ActivityChange {
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
