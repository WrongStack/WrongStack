import type { WSError } from './runtime.js';

type CollabPanelMessage =
  | WSCollabState
  | WSCollabParticipantJoined
  | WSCollabParticipantLeft
  | WSCollabAnnotationAdded
  | WSCollabAnnotationResolved
  | WSCollabPauseGranted
  | WSCollabPauseReleased
  | WSCollabInjectionGranted
  | WSError;

// ── Collaboration (Phase 1 of idea #13) ────────────────────────────────────
// Passive read-only session observer: a second client can join an active
// agent run and watch a live mirror of the kernel's iteration / tool /
// subagent events. Annotation and control hand-off land in Phase 2/3.

/**
 * Roles a collaboration participant can hold. The string union is the
 * wire contract — adding new roles (e.g. `controller`) in later phases
 * is a backward-compatible widening of this type as long as the server
 * gracefully rejects roles it does not yet implement.
 */
export type CollabRole = 'observer' | 'annotator' | 'controller';

// ── Client → Server ───────────────────────────────────────────────────────

export interface WSCollabJoin {
  type: 'collab.join';
  payload: { sessionId: string; role: CollabRole };
}

export interface WSCollabLeave {
  type: 'collab.leave';
  payload: { sessionId: string };
}

/**
 * Annotate a specific event in the session log. The `atEventIndex`
 * is a stable pointer the UI can scroll to / highlight. The server
 * persists the annotation and broadcasts it to every participant
 * in the same session, including the author.
 */
export interface WSCollabAnnotate {
  type: 'collab.annotate';
  payload: { sessionId: string; atEventIndex: number; text: string };
}

/** Mark an existing annotation as resolved. */
export interface WSCollabResolve {
  type: 'collab.resolve';
  payload: { sessionId: string; annotationId: string };
}

// ── Server → Client ───────────────────────────────────────────────────────

/** Sent on connect and every 2s while at least one participant is watching. */
export interface WSCollabState {
  type: 'collab.state';
  payload: {
    sessionId: string;
    participants: Array<{
      participantId: string;
      role: CollabRole;
      joinedAt: string;
    }>;
  };
}

/** Broadcast when a new participant joins the session. */
export interface WSCollabParticipantJoined {
  type: 'collab.participant.joined';
  payload: {
    participantId: string;
    sessionId: string;
    role: CollabRole;
    joinedAt: string;
  };
}

/** Broadcast when a participant leaves (explicit leave or WS close/error). */
export interface WSCollabParticipantLeft {
  type: 'collab.participant.left';
  payload: { participantId: string; sessionId: string };
}

/** Broadcast when a new annotation is added. Sent to all participants. */
export interface WSCollabAnnotationAdded {
  type: 'collab.annotation.added';
  payload: {
    sessionId: string;
    annotation: {
      id: string;
      atEventIndex: number;
      authorId: string;
      authorRole: 'annotator';
      text: string;
      createdAt: string;
      resolved: boolean;
    };
  };
}

/** Broadcast when an annotation is resolved. Sent to all participants. */
export interface WSCollabAnnotationResolved {
  type: 'collab.annotation.resolved';
  payload: {
    sessionId: string;
    annotationId: string;
    resolvedBy: string;
    resolvedAt: string;
  };
}

// ── Controller (Phase 3) ───────────────────────────────────────────────────
// The `controller` role can request a pause on the agent loop, resume
// it, and (later) inject manual tool calls. The pause/resume state is
// process-wide (single agent run per webui); the bus carries it.

/** Client → server: controller asks the agent loop to pause before the next tool call. */
export interface WSCollabRequestPause {
  type: 'collab.request_pause';
  payload: { sessionId: string };
}

/** Client → server: controller (or owner) clears the pause. */
export interface WSCollabResume {
  type: 'collab.resume';
  payload: { sessionId: string };
}

/**
 * Client → server: owner hands the controller role to a different
 * participant. The current implementation is metadata-only — the
 * existing controller's effective permissions don't change yet;
 * the wire is reserved for a future iteration where per-participant
 * RBAC becomes dynamic.
 */
export interface WSCollabGrantControl {
  type: 'collab.grant_control';
  payload: { sessionId: string; toParticipant: string };
}

/** Server → client: the bus transitioned to paused (controller's pause took effect). */
export interface WSCollabPauseGranted {
  type: 'collab.pause.granted';
  payload: {
    sessionId: string;
    pausedBy: string;
    pausedAt: string;
    /**
     * How long until the middleware auto-resumes (in ms). Clients
     * can render a countdown. Defaults to 60_000 on the server.
     */
    autoResumeInMs: number;
  };
}

/** Server → client: the bus transitioned back to running. */
export interface WSCollabPauseReleased {
  type: 'collab.pause.released';
  payload: {
    sessionId: string;
    /** 'controller' when a participant asked; 'timeout' when the middleware fired auto-resume. */
    reason: 'controller' | 'timeout';
    at: string;
  };
}

/**
 * Generic envelope wrapping a kernel event mirrored to observers.
 * `kind` matches the original kernel event name (e.g. `tool.started`),
 * `payload` is the original event payload (best-effort serialized),
 * `at` is the broadcast timestamp.
 *
 * `replay` is true when the event was sent from the on-disk session
 * log to a late-joining observer (Phase 1.5). Live events leave it
 * undefined. Clients use the flag to render a "history" affordance
 * (e.g. dim the styling or annotate the timestamp as "[joined late]").
 */
export interface WSCollabEvent {
  type: 'collab.event';
  payload: { kind: string; payload: unknown; at: string; replay?: boolean | undefined };
}

// ── Phase 4: manual tool-call injection (controller only) ───────────────────

/**
 * Client → server: a controller injects a synthetic tool_result for
 * the given tool_use_id. The next time the agent's toolCall pipeline
 * sees that id, the real tool is skipped and the injected content
 * is used. The injection is one-shot — consumed on first match.
 */
export interface WSCollabInjectTool {
  type: 'collab.inject_tool';
  payload: {
    sessionId: string;
    toolUseId: string;
    /** String or JSON-serializable value. */
    content: unknown;
    isError: boolean;
    /** Free-form context surfaced in the broadcast and audit log. */
    reason: string;
  };
}

/**
 * Server → client: an injection was queued or consumed. Sent to
 * every participant so observers can show "the controller just
 * replaced the tool result for tool X".
 */
export interface WSCollabInjectionGranted {
  type: 'collab.injection.granted';
  payload: {
    sessionId: string;
    toolUseId: string;
    toolName: string;
    authorId: string;
    reason: string;
    isError: boolean;
    /** 'queued' or 'consumed' — the bus does both. */
    phase: 'queued' | 'consumed';
    at: string;
  };
}
