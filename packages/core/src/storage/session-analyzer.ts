import type { SessionEvent } from '../types/session.js';

export interface QueryFilter {
  eventTypes?: string[] | undefined;
  toolNames?: string[] | undefined;
  timeRange?: { start: string; end: string } | undefined;
}

export interface ToolInvocation {
  ts: string;
  name: string;
  input: unknown;
  output?: unknown | undefined;
  error?: string | undefined;
  durationMs: number;
}

export interface SessionError {
  ts: string;
  phase: string;
  message: string;
}

export interface ModeChange {
  ts: string;
  from: string;
  to: string;
}

export interface TaskSummary {
  taskId: string;
  title: string;
  status: string;
  createdAt: string;
  completedAt?: string | undefined;
}

export interface SessionAnalysis {
  sessionId: string;
  totalDuration: number;
  toolUsageCount: Record<string, number>;
  errorCount: number;
  modeChanges: ModeChange[];
  tasks: TaskSummary[];
}

export class SessionAnalyzer {
  analyze(events: SessionEvent[]): SessionAnalysis {
    const toolUsageCount: Record<string, number> = {};
    const errors: SessionError[] = [];
    const modeChanges: ModeChange[] = [];
    const tasksById = new Map<string, TaskSummary>();
    let sessionId = '';

    for (const event of events) {
      // sessionId comes from session_start / session_resumed.
      if (event.type === 'session_start' || event.type === 'session_resumed') {
        if (!sessionId) sessionId = event.id;
      }
      if (event.type === 'tool_use') {
        toolUsageCount[event.name] = (toolUsageCount[event.name] ?? 0) + 1;
      }
      if (event.type === 'error') {
        errors.push({ ts: event.ts, phase: event.phase, message: event.message });
      }
      if (event.type === 'mode_changed') {
        modeChanges.push({ ts: event.ts, from: event.from, to: event.to });
      }
      if (event.type === 'task_created') {
        tasksById.set(event.taskId, {
          taskId: event.taskId,
          title: event.title,
          status: 'created',
          createdAt: event.ts,
        });
      }
      if (event.type === 'task_updated') {
        const t = tasksById.get(event.taskId);
        if (t) t.status = event.status;
      }
      if (event.type === 'task_completed') {
        const t = tasksById.get(event.taskId);
        if (t) {
          t.status = 'completed';
          t.completedAt = event.ts;
        } else {
          tasksById.set(event.taskId, {
            taskId: event.taskId,
            title: event.title,
            status: 'completed',
            createdAt: event.ts,
            completedAt: event.ts,
          });
        }
      }
      if (event.type === 'task_failed') {
        const t = tasksById.get(event.taskId);
        if (t) {
          t.status = 'failed';
          t.completedAt = event.ts;
        } else {
          tasksById.set(event.taskId, {
            taskId: event.taskId,
            title: event.title,
            status: 'failed',
            createdAt: event.ts,
            completedAt: event.ts,
          });
        }
      }
    }

    return {
      sessionId,
      totalDuration: this.calcDuration(events),
      toolUsageCount,
      errorCount: errors.length,
      modeChanges,
      tasks: Array.from(tasksById.values()),
    };
  }

  query(events: SessionEvent[], filter: QueryFilter): SessionEvent[] {
    return events.filter((e) => {
      if (filter.eventTypes?.length && !filter.eventTypes.includes(e.type)) return false;
      if (filter.toolNames?.length && e.type === 'tool_use') {
        const toolEvent = e as { type: 'tool_use'; name: string };
        if (!filter.toolNames.includes(toolEvent.name)) return false;
      }
      if (filter.timeRange) {
        const ts = Date.parse(e.ts) || 0;
        const start = Date.parse(filter.timeRange.start) || 0;
        const end = Date.parse(filter.timeRange.end) || Number.POSITIVE_INFINITY;
        if (ts < start || ts > end) return false;
      }
      return true;
    });
  }

  private calcDuration(events: SessionEvent[]): number {
    if (events.length < 2) return 0;
    const firstEvent = events[0];
    const lastEvent = events[events.length - 1];
    /* v8 ignore next -- defensive: length>=2 guard above guarantees both ends exist */
    if (!firstEvent || !lastEvent) return 0;
    const first = Date.parse(firstEvent.ts) || 0;
    const last = Date.parse(lastEvent.ts) || 0;
    return Math.max(0, last - first);
  }
}
