/**
 * The WebUI server's HTTP session API (`/api/sessions…`), which reads the
 * cross-process session registry: every live WrongStack session on the
 * machine, not only this server's. The handlers in webui-server
 * (http-server/api-handlers.ts) build their bodies against these types, and
 * `schema/openapi.json` is generated from them.
 *
 * A request presents the access token as the `X-WS-Token` header, the
 * `?token=` query parameter or the `ws_token` cookie. A POST without an
 * `Origin` header always needs it; any route does behind `--require-token`.
 * A refusal is `401`, a request from an untrusted browser origin `403`.
 */
import type { AgentLiveStatus, SessionLiveStatus } from '@wrongstack/core/storage';

/** Body of every non-2xx answer. */
export interface ApiErrorBody {
  error: string;
}

export interface ApiSessionAgent {
  id: string;
  name: string;
  status: AgentLiveStatus;
  currentTool?: string | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  iterations: number;
  toolCalls: number;
  lastActivityAt: string;
}

/** `GET /api/sessions` answers an array of these. */
export interface ApiSession {
  sessionId: string;
  projectSlug: string;
  projectName: string;
  projectRoot: string;
  workingDir: string;
  status: SessionLiveStatus;
  pid: number;
  startedAt: string;
  lastHeartbeatAt: string;
  agentCount: number;
  agents: ApiSessionAgent[];
}

/** `GET /api/sessions/{id}/agents` */
export interface ApiSessionAgents {
  sessionId: string;
  projectName: string;
  status: SessionLiveStatus;
  agents: ApiSessionAgent[];
}

/** One line of a session's recent activity. */
export interface ApiSessionEvent {
  ts: string;
  role: 'user' | 'assistant' | 'tool' | 'system' | 'error';
  /** Text summary; tool input and output may be clipped. */
  text: string;
  tool?: string | undefined;
  input?: unknown;
  output?: unknown;
  durationMs?: number | undefined;
  isError?: boolean | undefined;
  /** Pairs a tool call's start with its end. */
  toolUseId?: string | undefined;
}

/** `GET /api/sessions/{id}/events?limit=1..500` (default 200) */
export interface ApiSessionEvents {
  sessionId: string;
  status: SessionLiveStatus;
  clientType?: string | undefined;
  projectName: string;
  /** Events in the session; an upper bound when `truncated`. */
  total: number;
  truncated?: boolean | undefined;
  entries: ApiSessionEvent[];
}

/**
 * `POST /api/sessions/{id}/message` — delivered to the session's agent before
 * its next model call.
 */
export interface ApiSessionMessageRequest {
  text: string;
  /** Sender label; default `human@webui`. */
  from?: string | undefined;
  /** Default `steer`. */
  type?: 'steer' | 'ask' | 'assign' | 'note' | 'btw' | undefined;
  /** Default `high`. */
  priority?: 'low' | 'normal' | 'high' | undefined;
  subject?: string | undefined;
}

export interface ApiSessionMessageResponse {
  ok: true;
  id: string;
  to: string;
  type: 'steer' | 'ask' | 'assign' | 'note' | 'btw';
  /** The session's status when the message was delivered. */
  delivered: SessionLiveStatus;
}

/** `POST /api/sessions/{id}/interrupt` */
export interface ApiSessionInterruptRequest {
  reason?: string | undefined;
  from?: string | undefined;
}

export interface ApiSessionInterruptResponse {
  ok: true;
  id: string;
  to: string;
  delivered: SessionLiveStatus;
}
