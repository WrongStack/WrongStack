import type { MailboxMessage, SubagentView } from '../office/types';
import type { ChronicleEventView } from './chronicle-types';
import type { StoryMemoryTrace } from './story-host';

export type StoryKind =
  | 'model'
  | 'tool'
  | 'file'
  | 'memory'
  | 'agent'
  | 'mail'
  | 'alert'
  | 'session'
  | 'work';
export const STORY_COLORS: Record<StoryKind, string> = {
  model: 'hsl(var(--primary))',
  tool: 'hsl(var(--info))',
  file: 'hsl(var(--success))',
  memory: 'hsl(var(--warning))',
  agent: 'hsl(var(--destructive))',
  mail: 'hsl(var(--info))',
  alert: 'hsl(var(--brand-orange))',
  session: 'hsl(var(--muted-foreground))',
  work: 'hsl(var(--primary))',
};
export interface StoryEvent {
  id: string;
  at: number;
  kind: StoryKind;
  actor: string;
  title: string;
  detail: string;
  durationMs?: number | undefined;
  path?: string | undefined;
  raw?: ChronicleEventView | undefined;
}
export interface StoryActor {
  id: string;
  name: string;
  parent?: string | undefined;
  start: number;
  end: number;
  events: number;
  status?: string | undefined;
  task?: string | undefined;
  model?: string | undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
function timestamp(value: string | undefined): number | undefined {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}
function duration(event: ChronicleEventView): number | undefined {
  const ns = Number(event.durationNs);
  const ms =
    event.durationNs !== undefined && Number.isFinite(ns) && ns >= 0
      ? ns / 1e6
      : typeof event.attributes?.durationMs === 'number'
        ? event.attributes.durationMs
        : NaN;
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
}
export function storyKind(type: string, tool?: string): StoryKind {
  if (/drift|error|failed|retry|fallback|denied|conflict|loop_detected/.test(type)) return 'alert';
  if (/^memory\./.test(type) || /^(remember|forget|memory[._])/.test(tool ?? '')) return 'memory';
  if (/mail/.test(type) || /mail/.test(tool ?? '')) return 'mail';
  if (
    /task|kanban|goal|checkpoint|sdd|branch/.test(type) ||
    /^(task|kanban|plan|todo)$/.test(tool ?? '')
  )
    return 'work';
  if (/^file\.|resource\.observed|workspace\.files_materialized/.test(type)) return 'file';
  if (/tool/.test(type)) return 'tool';
  if (/subagent|agent\.|delegate|fleet/.test(type)) return 'agent';
  if (/provider|llm|thinking/.test(type)) return 'model';
  return 'session';
}

/** Only explicit tab ownership is accepted. No project-wide or unscoped bleed. */
export function buildSessionStory(
  sessionId: string,
  records: ChronicleEventView[],
  roster: readonly SubagentView[] = [],
  mail: readonly MailboxMessage[] = [],
  traces: readonly StoryMemoryTrace[] = [],
  projectRoot = '',
) {
  const owned = roster.filter((agent) => Boolean(sessionId) && agent.sessionId === sessionId);
  const names = new Map(owned.map((agent) => [agent.id, agent.name]));
  const actors = new Map<string, StoryActor>();
  const events: StoryEvent[] = [];
  const seen = new Set<string>();
  const calls = new Set<string>();
  const files = new Map<string, string>();
  const normalizedRoot = projectRoot.replace(/\\/g, '/').replace(/\/$/, '');
  const notePath = (path: string) => {
    let normalized = path.replace(/\\/g, '/');
    const windows = /^[a-z]:/i.test(normalizedRoot || normalized);
    if (
      normalizedRoot &&
      (windows
        ? normalized.toLowerCase().startsWith(`${normalizedRoot.toLowerCase()}/`)
        : normalized.startsWith(`${normalizedRoot}/`))
    )
      normalized = normalized.slice(normalizedRoot.length + 1);
    const key = windows ? normalized.toLowerCase() : normalized;
    if (!files.has(key)) files.set(key, normalized);
    return normalized;
  };
  const injectedIds = new Set<string>();
  let memoryWrites = 0;
  const inputPaths = new Map<string, string>();
  for (const record of records) {
    if (!sessionId || record.scope.sessionId !== sessionId) continue;
    const tool = string(record.attributes?.toolName) ?? string(record.attributes?.name);
    if (!['read', 'write', 'edit'].includes(tool ?? '')) continue;
    let input = record.attributes?.input;
    if (typeof input === 'string') {
      try {
        input = JSON.parse(input);
      } catch {
        continue;
      }
    }
    if (!input || typeof input !== 'object') continue;
    const path =
      string((input as Record<string, unknown>).path) ??
      string((input as Record<string, unknown>).file_path);
    const call =
      record.correlation.toolCallId ??
      string(record.attributes?.toolUseId) ??
      string(record.attributes?.id);
    if (path && call)
      inputPaths.set(
        `${record.scope.agentId ?? string(record.attributes?.subagentId) ?? 'session'}:${call}`,
        path,
      );
  }
  const knownTraces = new Set<string>();
  const branchNames = new Map<string, string>([['main', 'main']]);
  const branchParents = new Map<string, string>();
  const resolveBranchParentActor = (branchId: string): string => {
    const parentBranchId = branchParents.get(branchId);
    return parentBranchId && parentBranchId !== 'main' ? `branch:${parentBranchId}` : 'session';
  };
  const ensureActor = (id: string, at: number): StoryActor => {
    let actor = actors.get(id);
    if (!actor) {
      const branchId = id.startsWith('branch:') ? id.slice('branch:'.length) : undefined;
      const parentActorId = branchId ? resolveBranchParentActor(branchId) : undefined;
      if (parentActorId && parentActorId !== 'session' && parentActorId !== id) {
        ensureActor(parentActorId, at);
      }
      actor = {
        id,
        name: branchId
          ? `⎇ ${branchNames.get(branchId) ?? branchId}`
          : (names.get(id) ??
            (id === 'session' ? 'Session / unattributed' : `Agent ${id.slice(0, 12)}`)),
        ...(parentActorId ? { parent: parentActorId } : {}),
        start: at,
        end: at,
        events: 0,
      };
      actors.set(id, actor);
    } else if (id.startsWith('branch:')) {
      const branchId = id.slice('branch:'.length);
      const knownBranchName = branchNames.get(branchId);
      if (knownBranchName) actor.name = `⎇ ${knownBranchName}`;
      const parentActorId = resolveBranchParentActor(branchId);
      if (parentActorId !== id) {
        if (parentActorId !== 'session') ensureActor(parentActorId, at);
        actor.parent = parentActorId;
      }
    }
    actor.start = Math.min(actor.start, at);
    actor.end = Math.max(actor.end, at);
    return actor;
  };
  for (const record of records) {
    if (!sessionId || record.scope.sessionId !== sessionId || seen.has(record.eventId)) continue;
    seen.add(record.eventId);
    const at = timestamp(record.occurredAt) ?? timestamp(record.observedAt);
    if (at === undefined) continue;
    const attributes = record.attributes ?? {};
    const attrBranchId =
      string(attributes.branchId) ??
      string(attributes.newBranchId) ??
      string(attributes.toBranchId) ??
      string(attributes.sourceBranchId);
    const attrBranchName = string(attributes.branchName) ?? string(attributes.name);
    if (attrBranchId && attrBranchName) {
      branchNames.set(attrBranchId, attrBranchName);
    }
    if (record.eventType === 'branch_created') {
      const createdId = string(attributes.branchId) ?? string(attributes.newBranchId);
      const parentBranchId = string(attributes.parentBranchId);
      if (createdId && parentBranchId && createdId !== parentBranchId) {
        branchParents.set(createdId, parentBranchId);
      }
    }
    if (record.eventType === 'branch_folded' && record.outcome !== 'failure') {
      const foldedSourceId = string(attributes.sourceBranchId);
      if (foldedSourceId && foldedSourceId !== 'main') {
        ensureActor(`branch:${foldedSourceId}`, at).status = 'completed';
      }
    }
    const spawnedId =
      record.eventType === 'subagent.spawned' ? string(attributes.subagentId) : undefined;
    const baseActorId =
      spawnedId ?? record.scope.agentId ?? string(attributes.subagentId) ?? 'session';
    const actorId =
      baseActorId === 'session' && attrBranchId && attrBranchId !== 'main'
        ? `branch:${attrBranchId}`
        : baseActorId;
    const actor = ensureActor(actorId, at);
    if (record.runtime?.modelId) actor.model = record.runtime.modelId;
    const actorName =
      string(attributes.agentName) ??
      (record.eventType === 'subagent.spawned' ? string(attributes.name) : undefined);
    if (actorName && !actorName.startsWith('sha256:')) actor.name = actorName;
    const parent = string(attributes.parentAgentId);
    if (spawnedId && parent && parent !== spawnedId) actor.parent = parent;
    const tool =
      string(attributes.toolName) ??
      (record.eventType.startsWith('subagent.tool') ? string(attributes.name) : undefined);
    const path =
      record.resource?.path ??
      string(attributes.filePath) ??
      (record.outcome === 'success'
        ? inputPaths.get(
            `${actorId}:${record.correlation.toolCallId ?? string(attributes.toolUseId) ?? string(attributes.id)}`,
          )
        : undefined);
    if (path) notePath(path);
    if (record.eventType === 'memory.injector_run' && Array.isArray(attributes.injected))
      for (const item of attributes.injected) {
        if (item && typeof item === 'object') {
          const id = string((item as Record<string, unknown>).id);
          if (id) injectedIds.add(id);
        }
      }
    if (
      (record.outcome === 'success' &&
        ['remember', 'memory.sage.remember', 'memory_update'].includes(tool ?? '')) ||
      (/^memory\.(created|remembered|updated|persisted)$/.test(record.eventType) &&
        record.outcome !== 'failure')
    )
      memoryWrites++;
    if (/^(tool\.(started|executed)|subagent\.tool_(started|executed))$/.test(record.eventType))
      calls.add(
        `${actorId}:${record.correlation.toolCallId ?? string(attributes.toolUseId) ?? string(attributes.id) ?? record.eventId}`,
      );
    const ms = duration(record);
    actor.events++;
    if (ms !== undefined) actor.start = Math.min(actor.start, at - ms);
    const runId = string(attributes.runId);
    if (record.eventType === 'memory.injector_run' && runId) knownTraces.add(runId);
    const branchTitle =
      record.eventType === 'branch_created'
        ? `⎇ Branch created: ${string(attributes.name) ?? string(attributes.branchId) ?? 'branch'}`
        : record.eventType === 'branch_switched' || record.eventType === 'session.branch_switched'
          ? `⎇ Switched branch → ${branchNames.get(string(attributes.toBranchId) ?? '') ?? string(attributes.toBranchId) ?? 'branch'}`
          : record.eventType === 'branch_folded'
            ? `⎇ Folded ${branchNames.get(string(attributes.sourceBranchId) ?? '') ?? string(attributes.sourceBranchId) ?? 'branch'} → ${branchNames.get(string(attributes.targetBranchId) ?? '') ?? string(attributes.targetBranchId) ?? 'main'}`
            : undefined;
    events.push({
      id: record.eventId,
      at,
      actor: actorId,
      kind: storyKind(record.eventType, tool),
      title: branchTitle ?? tool ?? string(attributes.operation) ?? record.eventType,
      detail: [record.eventType, record.outcome, path].filter(Boolean).join(' · '),
      durationMs: ms,
      path,
      raw: record,
    });
  }
  for (const agent of owned) {
    if (!Number.isFinite(agent.startedAt) || agent.startedAt <= 0) continue;
    const actor = ensureActor(agent.id, agent.startedAt);
    actor.name = agent.name;
    actor.status = agent.status;
    actor.task = agent.description;
    actor.model = agent.model ?? actor.model;
    if (agent.completedAt !== undefined && Number.isFinite(agent.completedAt))
      actor.end = Math.max(actor.end, agent.completedAt);
  }
  const memberIds = new Set(
    [...actors.keys(), ...owned.map((agent) => agent.id)].filter((id) => id !== 'session'),
  );
  for (const message of mail) {
    if (!sessionId) continue;
    if (
      !(
        message.senderSessionId === sessionId ||
        message.recipientSessionId === sessionId ||
        message.to === `@session:${sessionId}` ||
        memberIds.has(message.from) ||
        memberIds.has(message.to)
      )
    )
      continue;
    const at = timestamp(message.timestamp);
    if (at === undefined || seen.has(`mail:${message.id}`)) continue;
    seen.add(`mail:${message.id}`);
    const actorId = memberIds.has(message.from)
      ? message.from
      : memberIds.has(message.to)
        ? message.to
        : 'session';
    ensureActor(actorId, at).events++;
    events.push({
      id: `mail:${message.id}`,
      at,
      actor: actorId,
      kind: 'mail',
      title: message.subject || message.type,
      detail: `${message.from} → ${message.to} · ${message.priority}\n${message.body.slice(0, 3000)}`,
    });
  }
  for (const trace of traces) {
    if (!sessionId) continue;
    if (trace.sessionId !== sessionId) continue;
    for (const memory of trace.injected) injectedIds.add(memory.id);
    if (knownTraces.has(trace.runId)) continue;
    const at = timestamp(trace.at);
    if (at === undefined) continue;
    ensureActor('session', at).events++;
    events.push({
      id: `memory:${trace.runId}`,
      at,
      actor: 'session',
      kind: 'memory',
      title: `${trace.injected.length} memories injected`,
      detail: `${trace.toolName} · ${trace.outcome} · ${trace.injectedChars} characters`,
    });
  }
  events.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  const lanes = [...actors.values()].sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
  const start = Math.min(...lanes.map((actor) => actor.start), events[0]?.at ?? Infinity);
  const end = Math.max(...lanes.map((actor) => actor.end), events.at(-1)?.at ?? -Infinity);
  const counts = Object.fromEntries(
    Object.keys(STORY_COLORS).map((kind) => [
      kind,
      events.filter((event) => event.kind === kind).length,
    ]),
  ) as Record<StoryKind, number>;
  return {
    events,
    actors: lanes,
    start: Number.isFinite(start) ? start : 0,
    end: Number.isFinite(end) ? end : 0,
    counts,
    toolCalls: calls.size,
    files: [...files.values()],
    memoryWrites,
    observedInjectedMemories: injectedIds.size,
  };
}
