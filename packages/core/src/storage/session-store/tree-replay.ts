import type { ContentBlock } from '@wrongstack/contracts/types/blocks';
import type { Message } from '@wrongstack/contracts/types/messages';
import type {
  SessionBranchDescriptor,
  SessionData,
  SessionEvent,
  SessionTreeSnapshot,
  WorkspaceCheckpointRef,
} from '@wrongstack/contracts/types/session';
import type { EventBus } from '../event-bus-port.js';
import { applyContextSnapshot, replayableMessage, trackMessageToolState } from './replay.js';

export const MAIN_BRANCH_ID = 'main';

export interface BranchReplayState {
  messages: Message[];
  openToolUses: Set<string>;
  exactJournalActive: boolean;
  messageIndexOffset: number;
  lengthBeforeInput: number | null;
}

function cloneBranchReplayState(src: BranchReplayState): BranchReplayState {
  return {
    messages: src.messages.map((m) => ({
      ...m,
      ...(Array.isArray(m.content) ? { content: [...m.content] } : {}),
    })),
    openToolUses: new Set(src.openToolUses),
    exactJournalActive: src.exactJournalActive,
    messageIndexOffset: src.messageIndexOffset,
    lengthBeforeInput: src.lengthBeforeInput,
  };
}

function emptyBranchReplayState(): BranchReplayState {
  return {
    messages: [],
    openToolUses: new Set(),
    exactJournalActive: false,
    messageIndexOffset: 0,
    lengthBeforeInput: null,
  };
}

type SnapshotEvent = Extract<SessionEvent, { type: 'messages_replaced' | 'context_snapshot' }>;

function isStrippedSnapshot(event: SnapshotEvent): boolean {
  return (
    event.messages.length === 0 &&
    typeof event.messagesOmitted === 'number' &&
    event.messagesOmitted > 0
  );
}

function isJournalEchoOfInput(messages: readonly Message[], message: Message): boolean {
  const last = messages[messages.length - 1];
  return (
    last?.role === 'user' &&
    message.role === 'user' &&
    JSON.stringify(last.content) === JSON.stringify(message.content)
  );
}

function shouldReplaceLegacyReplay(messages: readonly Message[], eventTs: string): boolean {
  if (messages.length === 0) return true;
  const lastTs = messages[messages.length - 1]?.ts;
  return typeof lastTs === 'string' && lastTs >= eventTs;
}

function dropRewoundPrompt(messages: Message[], openToolUses: Set<string>, keep: number): void {
  if (messages.length <= keep) return;
  messages.length = keep;
  openToolUses.clear();
  for (const current of messages) trackMessageToolState(current, openToolUses);
}

export function applyEventToBranchState(
  state: BranchReplayState,
  ev: SessionEvent,
  sessionId: string,
  events?: EventBus | undefined,
): void {
  if (ev.type === 'user_input') {
    state.lengthBeforeInput = state.messages.length;
  } else if (
    ev.type === 'messages_replaced' ||
    ev.type === 'context_snapshot' ||
    ev.type === 'messages_dropped'
  ) {
    state.lengthBeforeInput = null;
  } else if (ev.type === 'rewound' && state.lengthBeforeInput !== null) {
    dropRewoundPrompt(state.messages, state.openToolUses, state.lengthBeforeInput);
    state.lengthBeforeInput = null;
  }

  if (ev.type === 'branch_folded') {
    const summaryMsg = replayableMessage(ev.summaryMessage, ev.ts);
    if (summaryMsg) {
      state.messages.push(summaryMsg);
      trackMessageToolState(summaryMsg, state.openToolUses);
    }
    return;
  }

  if (ev.type === 'message_appended' && ev.version === 1) {
    const message = replayableMessage(ev.message, ev.ts);
    if (message) {
      if (!state.exactJournalActive && shouldReplaceLegacyReplay(state.messages, ev.ts)) {
        state.messages.length = 0;
        state.openToolUses.clear();
        state.messageIndexOffset = 0;
      } else if (!state.exactJournalActive && isJournalEchoOfInput(state.messages, message)) {
        state.messages.pop();
      }
      state.exactJournalActive = true;
      state.messages.push(message);
      trackMessageToolState(message, state.openToolUses);
    } else {
      events?.emit('session.damaged', {
        sessionId,
        detail: 'Ignored malformed message_appended event',
      });
    }
    return;
  }

  if (ev.type === 'message_updated' && ev.version === 1) {
    const message = replayableMessage(ev.message, ev.ts);
    const index = ev.index - state.messageIndexOffset;
    if (message && state.exactJournalActive && index >= 0 && index < state.messages.length) {
      state.messages[index] = message;
      state.openToolUses.clear();
      for (const current of state.messages) trackMessageToolState(current, state.openToolUses);
    }
    return;
  }

  if (ev.type === 'messages_replaced' && ev.version === 1) {
    if (
      !isStrippedSnapshot(ev) &&
      applyContextSnapshot(state.messages, state.openToolUses, ev.messages)
    ) {
      state.exactJournalActive = true;
      state.messageIndexOffset = 0;
    }
    return;
  }

  if (ev.type === 'messages_dropped' && ev.version === 1) {
    if (state.exactJournalActive && Number.isInteger(ev.count) && ev.count > 0) {
      const dropped = Math.min(ev.count, state.messages.length);
      state.messages.splice(0, dropped);
      state.messageIndexOffset += dropped;
      state.openToolUses.clear();
      for (const current of state.messages) trackMessageToolState(current, state.openToolUses);
    }
    return;
  }

  if (ev.type === 'context_snapshot') {
    if (
      !isStrippedSnapshot(ev) &&
      applyContextSnapshot(state.messages, state.openToolUses, ev.messages)
    ) {
      state.messageIndexOffset = 0;
    }
    return;
  }

  if (!state.exactJournalActive && ev.type === 'user_input') {
    state.openToolUses.clear();
    state.messages.push({ role: 'user', content: ev.content, ts: ev.ts });
  } else if (!state.exactJournalActive && ev.type === 'llm_response') {
    state.messages.push({ role: 'assistant', content: ev.content, ts: ev.ts });
    for (const b of ev.content) {
      if (b.type === 'tool_use') state.openToolUses.add(b.id);
    }
  } else if (!state.exactJournalActive && ev.type === 'tool_result') {
    if (!state.openToolUses.has(ev.id)) return;
    state.openToolUses.delete(ev.id);
    const resultBlock: ContentBlock = {
      type: 'tool_result',
      tool_use_id: ev.id,
      content: typeof ev.content === 'string' ? ev.content : JSON.stringify(ev.content),
      is_error: ev.isError,
    };
    const last = state.messages[state.messages.length - 1];
    const lastIsToolResultUser =
      last?.role === 'user' &&
      Array.isArray(last.content) &&
      last.content.every((b) => (b as ContentBlock).type === 'tool_result');
    if (lastIsToolResultUser && Array.isArray(last.content)) {
      last.content.push(resultBlock);
    } else {
      state.messages.push({ role: 'user', content: [resultBlock], ts: ev.ts });
    }
  }
}

function isUserTurnEvent(ev: SessionEvent): boolean {
  if (ev.type === 'user_input') return true;
  if (ev.type === 'message_appended' && ev.version === 1 && ev.message.role === 'user') {
    // Exclude synthetic tool_result-only user messages from human turn counts.
    if (
      Array.isArray(ev.message.content) &&
      ev.message.content.length > 0 &&
      ev.message.content.every((b) => b.type === 'tool_result')
    ) {
      return false;
    }
    return true;
  }
  return false;
}

/**
 * Streaming single-pass Session Tree DAG tracker.
 *
 * When a journal never emits `branch_created`, `hasBranched` remains `false`
 * and zero per-branch message clones are allocated. The moment `branch_created`
 * is encountered, `SessionTreeTracker` seeds `main` from the caller's live
 * replay state (or retained events for historical `--at` forks) and isolates
 * every branch's conversation window, compactions, and CAS workspace refs.
 */
export class SessionTreeTracker {
  private readonly branches = new Map<string, SessionBranchDescriptor>();
  private readonly states = new Map<string, BranchReplayState>();
  private readonly branchLastSeq = new Map<string, number>();
  private readonly pendingUserInputEcho = new Set<string>();
  private _activeBranchId: string = MAIN_BRANCH_ID;
  private _headSeq = -1;
  private _hasBranched = false;
  private readonly replayMessages: boolean;
  private readonly sessionId: string;
  private readonly eventBus: EventBus | undefined;

  constructor(opts: {
    sessionId: string;
    replayMessages: boolean;
    events?: EventBus | undefined;
  }) {
    this.sessionId = opts.sessionId;
    this.replayMessages = opts.replayMessages;
    this.eventBus = opts.events;
  }

  get hasBranched(): boolean {
    return this._hasBranched;
  }

  get activeBranchId(): string {
    return this._activeBranchId;
  }

  get headSeq(): number {
    return this._headSeq;
  }

  private ensureMain(ts: string): SessionBranchDescriptor {
    let main = this.branches.get(MAIN_BRANCH_ID);
    if (!main) {
      main = {
        id: MAIN_BRANCH_ID,
        name: MAIN_BRANCH_ID,
        parentBranchId: null,
        forkSeq: 0,
        createdAt: ts,
        lastActivityAt: ts,
        status: 'active',
        turnCount: 0,
      };
      this.branches.set(MAIN_BRANCH_ID, main);
    }
    return main;
  }

  /**
   * Observe one event in chronological journal order.
   *
   * `linearState` is the caller's pre-branch linear replay state so we only
   * materialize `BranchReplayState` maps when `branch_created` actually occurs!
   */
  observe(
    ev: SessionEvent,
    seq: number,
    retainedEvents: readonly SessionEvent[],
    retainedDroppedOffset: number,
    linearState?: BranchReplayState | undefined,
  ): void {
    this._headSeq = Math.max(this._headSeq, seq);
    const main = this.ensureMain(ev.ts);
    const owningBranchId = ev.branchId ?? MAIN_BRANCH_ID;

    if (ev.type === 'branch_created') {
      if (!this._hasBranched) {
        this._hasBranched = true;
        if (this.replayMessages && linearState) {
          this.states.set(MAIN_BRANCH_ID, cloneBranchReplayState(linearState));
        }
      }
      const parentId = this.branches.has(ev.parentBranchId) ? ev.parentBranchId : MAIN_BRANCH_ID;
      const descriptor: SessionBranchDescriptor = {
        id: ev.newBranchId,
        name: ev.name,
        ...(ev.label ? { label: ev.label } : {}),
        parentBranchId: parentId,
        forkSeq: ev.forkSeq,
        ...(ev.forkPromptIndex !== undefined ? { forkPromptIndex: ev.forkPromptIndex } : {}),
        createdAt: ev.ts,
        lastActivityAt: ev.ts,
        status: 'active',
        ...(ev.baseWorkspaceCheckpoint
          ? {
              baseWorkspaceCheckpoint: ev.baseWorkspaceCheckpoint,
              latestWorkspaceCheckpoint: ev.baseWorkspaceCheckpoint,
            }
          : {}),
        turnCount: 0,
      };
      this.branches.set(ev.newBranchId, descriptor);

      if (this.replayMessages) {
        const parentHeadSeq = this.branchLastSeq.get(parentId) ?? -1;
        const parentLiveState = this.states.get(parentId);
        if (parentLiveState && ev.forkSeq >= parentHeadSeq) {
          this.states.set(ev.newBranchId, cloneBranchReplayState(parentLiveState));
        } else {
          this.states.set(
            ev.newBranchId,
            this.reconstructLineagePrefix(
              parentId,
              ev.forkSeq,
              retainedEvents,
              retainedDroppedOffset,
            ),
          );
        }
      }
      return;
    }

    if (ev.type === 'branch_switched') {
      if (!this._hasBranched) {
        this._hasBranched = true;
        if (this.replayMessages && linearState) {
          this.states.set(MAIN_BRANCH_ID, cloneBranchReplayState(linearState));
        }
      }
      const fromBranch = this.branches.get(ev.fromBranchId);
      if (fromBranch) {
        fromBranch.lastActivityAt = ev.ts;
        if (ev.departureCheckpoint) {
          fromBranch.latestWorkspaceCheckpoint = ev.departureCheckpoint;
        }
      }
      if (this.branches.has(ev.toBranchId)) {
        this._activeBranchId = ev.toBranchId;
      }
      return;
    }

    if (ev.type === 'branch_folded') {
      if (!this._hasBranched) {
        this._hasBranched = true;
        if (this.replayMessages && linearState) {
          this.states.set(MAIN_BRANCH_ID, cloneBranchReplayState(linearState));
        }
      }
      const source = this.branches.get(ev.sourceBranchId);
      if (source) {
        source.status = ev.archiveSource ? 'archived' : 'folded';
        source.foldedIntoBranchId = ev.targetBranchId;
        source.lastActivityAt = ev.ts;
      }
      const target = this.branches.get(ev.targetBranchId);
      if (target) {
        target.lastActivityAt = ev.ts;
      }
      if (this.replayMessages) {
        const targetState = this.states.get(ev.targetBranchId);
        if (targetState) {
          applyEventToBranchState(targetState, ev, this.sessionId, this.eventBus);
        }
      }
      this.branchLastSeq.set(ev.targetBranchId, seq);
      return;
    }

    if (ev.type === 'branch_status_changed') {
      const target = this.branches.get(ev.targetBranchId);
      if (target) {
        if (ev.status !== undefined) target.status = ev.status;
        if (ev.name !== undefined && ev.name.trim().length > 0) target.name = ev.name.trim();
        target.lastActivityAt = ev.ts;
      }
      return;
    }

    // Ordinary conversation / checkpoint / tool event:
    const branch = this.branches.get(owningBranchId) ?? main;
    branch.lastActivityAt = ev.ts;
    if (isUserTurnEvent(ev)) {
      if (ev.type === 'user_input') {
        branch.turnCount += 1;
        this.pendingUserInputEcho.add(branch.id);
      } else if (this.pendingUserInputEcho.has(branch.id)) {
        this.pendingUserInputEcho.delete(branch.id);
      } else {
        branch.turnCount += 1;
      }
    } else if (
      ev.type === 'llm_response' ||
      (ev.type === 'message_appended' && ev.message.role === 'assistant')
    ) {
      this.pendingUserInputEcho.delete(branch.id);
    }
    const wsCheckpoint = extractWorkspaceCheckpoint(ev);
    if (wsCheckpoint) {
      branch.latestWorkspaceCheckpoint = wsCheckpoint;
      if (!branch.baseWorkspaceCheckpoint && branch.id === MAIN_BRANCH_ID) {
        branch.baseWorkspaceCheckpoint = wsCheckpoint;
      }
    }
    this.branchLastSeq.set(branch.id, seq);

    if (this._hasBranched && this.replayMessages) {
      let state = this.states.get(branch.id);
      if (!state) {
        state = emptyBranchReplayState();
        this.states.set(branch.id, state);
      }
      applyEventToBranchState(state, ev, this.sessionId, this.eventBus);
    }
  }

  private reconstructLineagePrefix(
    leafBranchId: string,
    maxLeafSeq: number,
    retainedEvents: readonly SessionEvent[],
    retainedDroppedOffset: number,
  ): BranchReplayState {
    const segments = buildBranchLineageSegments(this.branches, leafBranchId, maxLeafSeq);
    const state = emptyBranchReplayState();
    for (let i = 0; i < retainedEvents.length; i += 1) {
      const ev = retainedEvents[i]!;
      const seq = typeof ev.seq === 'number' ? ev.seq : retainedDroppedOffset + i;
      if (eventBelongsToLineage(ev, seq, segments)) {
        applyEventToBranchState(state, ev, this.sessionId, this.eventBus);
      }
    }
    return state;
  }

  getBranchState(branchId: string): BranchReplayState | undefined {
    return this.states.get(branchId);
  }

  snapshot(): SessionTreeSnapshot {
    if (this.branches.size === 0) {
      this.ensureMain(new Date(0).toISOString());
    }
    const record: Record<string, SessionBranchDescriptor> = {};
    for (const [id, desc] of this.branches) {
      record[id] = { ...desc };
    }
    return {
      activeBranchId: this._activeBranchId,
      branches: record,
      headSeq: this._headSeq,
    };
  }
}

export interface LineageSegment {
  branchId: string;
  maxSeq: number;
}

export function buildBranchLineageSegments(
  branches:
    | ReadonlyMap<string, SessionBranchDescriptor>
    | Readonly<Record<string, SessionBranchDescriptor>>,
  targetBranchId: string,
  targetMaxSeq = Number.POSITIVE_INFINITY,
): LineageSegment[] {
  const isBranchMap = (
    value:
      | ReadonlyMap<string, SessionBranchDescriptor>
      | Readonly<Record<string, SessionBranchDescriptor>>,
  ): value is ReadonlyMap<string, SessionBranchDescriptor> =>
    typeof (value as ReadonlyMap<string, SessionBranchDescriptor>).get === 'function';
  const getBranch = (id: string): SessionBranchDescriptor | undefined =>
    isBranchMap(branches) ? branches.get(id) : branches[id];

  const chain: LineageSegment[] = [];
  let currentId: string | null = targetBranchId;
  let boundSeq = targetMaxSeq;
  const visited = new Set<string>();

  while (currentId !== null && !visited.has(currentId)) {
    visited.add(currentId);
    chain.push({ branchId: currentId, maxSeq: boundSeq });
    const desc = getBranch(currentId);
    if (!desc || desc.parentBranchId === null) break;
    boundSeq = desc.forkSeq;
    currentId = desc.parentBranchId;
  }

  return chain.reverse();
}

export function eventBelongsToLineage(
  ev: SessionEvent,
  seq: number,
  segments: readonly LineageSegment[],
): boolean {
  if (
    ev.type === 'branch_created' ||
    ev.type === 'branch_switched' ||
    ev.type === 'branch_status_changed'
  ) {
    return false;
  }
  if (ev.type === 'branch_folded') {
    const seg = segments.find((s) => s.branchId === ev.targetBranchId);
    return seg !== undefined && seq <= seg.maxSeq;
  }
  const evBranch = ev.branchId ?? MAIN_BRANCH_ID;
  const seg = segments.find((s) => s.branchId === evBranch);
  return seg !== undefined && seq <= seg.maxSeq;
}

function extractWorkspaceCheckpoint(ev: SessionEvent): WorkspaceCheckpointRef | undefined {
  if (ev.type === 'checkpoint' || ev.type === 'workspace_checkpoint') {
    return ev.workspaceCheckpoint;
  }
  return undefined;
}

/**
 * Reconstruct the full `SessionTreeSnapshot` and any target branch's exact
 * `Message[]` conversation from an in-memory `SessionEvent[]` array.
 */
export function reconstructSessionTree(
  events: readonly SessionEvent[],
  opts: {
    sessionId?: string | undefined;
    targetBranchId?: string | undefined;
    maxSeq?: number | undefined;
  } = {},
): {
  tree: SessionTreeSnapshot;
  messages: Message[];
  openToolUses: Set<string>;
} {
  const sessionId = opts.sessionId ?? 'session';
  const tracker = new SessionTreeTracker({ sessionId, replayMessages: false });
  for (let i = 0; i < events.length; i += 1) {
    const ev = events[i]!;
    const seq = typeof ev.seq === 'number' ? ev.seq : i;
    tracker.observe(ev, seq, events, 0);
  }
  const tree = tracker.snapshot();
  const branchId = opts.targetBranchId ?? tree.activeBranchId;
  const segments = buildBranchLineageSegments(
    tree.branches,
    branchId,
    opts.maxSeq ?? Number.POSITIVE_INFINITY,
  );
  const state = emptyBranchReplayState();
  for (let i = 0; i < events.length; i += 1) {
    const ev = events[i]!;
    const seq = typeof ev.seq === 'number' ? ev.seq : i;
    if (eventBelongsToLineage(ev, seq, segments)) {
      applyEventToBranchState(state, ev, sessionId);
    }
  }
  return {
    tree,
    messages: state.messages,
    openToolUses: state.openToolUses,
  };
}

/**
 * Return `data.tree` when present, or synthesize the single-branch `main`
 * snapshot for unbranched sessions without mutating `data`.
 */
export function getSessionTreeSnapshot(
  data: Pick<SessionData, 'metadata' | 'events' | 'tree'>,
): SessionTreeSnapshot {
  if (data.tree) return data.tree;
  return reconstructSessionTree(data.events, { sessionId: data.metadata.id }).tree;
}
