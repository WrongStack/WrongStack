import {
  checkMailboxSendType,
  MAILBOX_MAX_BODY_LENGTH,
  MAILBOX_MAX_SUBJECT_LENGTH,
  MAILBOX_SENDABLE_MESSAGE_TYPES,
  type MailboxMessageType,
  normalizeRecipient,
} from '@wrongstack/coordination';
import { errMessage } from './ws-utils.js';
import type { PayloadValidationResult } from './ws-validation-common.js';
import { isRecord } from './ws-validation-common.js';

/**
 * The message types a human send may carry.
 *
 * `control` is reserved for the runtime, so it is excluded from the union
 * and from the accepted runtime set — both derived from the canonical
 * `MailboxMessageType` union in `@wrongstack/coordination` so this surface
 * cannot drift from the mailbox's own vocabulary.
 */
export type MailboxSendableMessageType = Exclude<MailboxMessageType, 'control'>;

interface MailboxMessagesPayload {
  limit?: number;
  agentId?: string;
  unreadOnly?: boolean;
  incompleteOnly?: boolean;
}

export function validateMailboxMessagesPayload(
  payload: unknown,
): PayloadValidationResult<MailboxMessagesPayload | undefined> {
  if (payload === undefined) return { ok: true, value: undefined };
  if (!isRecord(payload)) {
    return { ok: false, message: 'mailbox.messages payload must be an object when provided' };
  }
  const limit = payload['limit'];
  const agentId = payload['agentId'];
  const unreadOnly = payload['unreadOnly'];
  const incompleteOnly = payload['incompleteOnly'];
  if (limit !== undefined && (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 1)) {
    return {
      ok: false,
      message: 'mailbox.messages payload.limit must be a positive number when provided',
    };
  }
  if (agentId !== undefined && typeof agentId !== 'string') {
    return {
      ok: false,
      message: 'mailbox.messages payload.agentId must be a string when provided',
    };
  }
  if (unreadOnly !== undefined && typeof unreadOnly !== 'boolean') {
    return {
      ok: false,
      message: 'mailbox.messages payload.unreadOnly must be a boolean when provided',
    };
  }
  if (incompleteOnly !== undefined && typeof incompleteOnly !== 'boolean') {
    return {
      ok: false,
      message: 'mailbox.messages payload.incompleteOnly must be a boolean when provided',
    };
  }
  return {
    ok: true,
    value: {
      ...(limit !== undefined ? { limit: limit as number } : {}),
      ...(agentId !== undefined ? { agentId: agentId as string } : {}),
      ...(unreadOnly !== undefined ? { unreadOnly: unreadOnly as boolean } : {}),
      ...(incompleteOnly !== undefined ? { incompleteOnly: incompleteOnly as boolean } : {}),
    },
  };
}

interface MailboxAgentsPayload {
  onlineOnly?: boolean;
}

const MAILBOX_ACTIONS = new Set(['mark-read', 'acknowledge', 'reopen', 'soft-delete']);

export interface MailboxActionPayload {
  requestId: string;
  mailId: string;
  action: 'mark-read' | 'acknowledge' | 'reopen' | 'soft-delete';
  readerId: string;
}

export function validateMailboxActionPayload(
  payload: unknown,
): PayloadValidationResult<MailboxActionPayload> {
  if (!isRecord(payload)) {
    return { ok: false, message: 'mailbox.action payload must be an object' };
  }
  const requestId = payload['requestId'];
  const mailId = payload['mailId'];
  const action = payload['action'];
  const readerId = payload['readerId'];
  if (typeof requestId !== 'string' || requestId.trim().length === 0) {
    return { ok: false, message: 'mailbox.action payload.requestId must be a non-empty string' };
  }
  if (typeof mailId !== 'string' || mailId.trim().length === 0) {
    return { ok: false, message: 'mailbox.action payload.mailId must be a non-empty string' };
  }
  if (typeof action !== 'string' || !MAILBOX_ACTIONS.has(action)) {
    return { ok: false, message: 'mailbox.action payload.action must be a supported action' };
  }
  if (typeof readerId !== 'string' || readerId.trim().length === 0) {
    return { ok: false, message: 'mailbox.action payload.readerId must be a non-empty string' };
  }
  return {
    ok: true,
    value: {
      requestId: requestId.trim(),
      mailId: mailId.trim(),
      action: action as MailboxActionPayload['action'],
      readerId: readerId.trim(),
    },
  };
}

const MAILBOX_SEND_TYPES: ReadonlySet<string> = new Set(MAILBOX_SENDABLE_MESSAGE_TYPES);

export interface MailboxSendPayload {
  requestId: string;
  from?: string | undefined;
  to: string;
  type: MailboxSendableMessageType;
  audience: 'all' | 'leaders';
  subject: string;
  body: string;
  priority: 'low' | 'normal' | 'high';
  replyTo?: string | undefined;
  /**
   * The tab this message was composed in.
   *
   * Carried because `to: 'leader'` is AMBIGUOUS once a WebUI page holds four
   * sessions: every tab's agent is registered as a leader, so an unscoped
   * message addressed that way is folded into whichever of them happens to
   * poll the mailbox — a "btw" typed in tab 3 steering the run in tab 1.
   */
  sessionId?: string | undefined;
}

export function validateMailboxSendPayload(
  payload: unknown,
): PayloadValidationResult<MailboxSendPayload> {
  if (!isRecord(payload)) {
    return { ok: false, message: 'mailbox.send payload must be an object' };
  }
  const requestId = payload['requestId'];
  const rawFrom = payload['from'];
  const rawTo = payload['to'];
  const rawType = payload['type'];
  const rawAudience = payload['audience'];
  const rawSubject = payload['subject'];
  const rawBody = payload['body'];
  const rawPriority = payload['priority'];
  const rawReplyTo = payload['replyTo'];
  const rawSessionId = payload['sessionId'];

  if (typeof requestId !== 'string' || requestId.trim().length === 0) {
    return { ok: false, message: 'mailbox.send payload.requestId must be a non-empty string' };
  }
  if (rawFrom !== undefined && (typeof rawFrom !== 'string' || rawFrom.trim().length === 0)) {
    return {
      ok: false,
      message: 'mailbox.send payload.from must be a non-empty string when provided',
    };
  }
  if (typeof rawTo !== 'string' || rawTo.trim().length === 0) {
    return { ok: false, message: 'mailbox.send payload.to must be a non-empty string' };
  }
  if (typeof rawType !== 'string' || !MAILBOX_SEND_TYPES.has(rawType)) {
    return {
      ok: false,
      message: 'mailbox.send payload.type must be a supported non-control message type',
    };
  }
  if (rawAudience !== 'all' && rawAudience !== 'leaders') {
    return { ok: false, message: 'mailbox.send payload.audience must be all or leaders' };
  }
  if (typeof rawSubject !== 'string' || rawSubject.trim().length === 0) {
    return { ok: false, message: 'mailbox.send payload.subject must be a non-empty string' };
  }
  if (typeof rawBody !== 'string' || rawBody.trim().length === 0) {
    return { ok: false, message: 'mailbox.send payload.body must be a non-empty string' };
  }
  if (rawPriority !== 'low' && rawPriority !== 'normal' && rawPriority !== 'high') {
    return { ok: false, message: 'mailbox.send payload.priority must be low, normal, or high' };
  }
  if (rawReplyTo !== undefined && typeof rawReplyTo !== 'string') {
    return { ok: false, message: 'mailbox.send payload.replyTo must be a string when provided' };
  }
  if (rawSessionId !== undefined && typeof rawSessionId !== 'string') {
    return { ok: false, message: 'mailbox.send payload.sessionId must be a string when provided' };
  }

  const type = rawType as MailboxSendPayload['type'];
  // The recipient is normalized by the SHARED normalizer (the agent tools
  // and the HQ route apply the same rule): `all` → `*`, bare `@session` →
  // the sender's session scope. Normalizing BEFORE the shared send-type
  // check matters — `assign`/`steer` addressed to an unnormalized
  // `@session` would pass the guard here and only fail later in the
  // mailbox itself.
  const trimmedSessionId = typeof rawSessionId === 'string' ? rawSessionId.trim() : '';
  const senderSessionId = trimmedSessionId.length > 0 ? trimmedSessionId : undefined;
  const trimmedReplyTo = typeof rawReplyTo === 'string' ? rawReplyTo.trim() : '';
  // `broadcast` targets the project wildcard regardless of the typed
  // recipient (the composer prefills a placeholder); every other recipient
  // goes through the shared normalizer (`all` → `*`, bare `@session` → the
  // sender's session scope).
  let to: string;
  try {
    to = type === 'broadcast' ? '*' : normalizeRecipient(rawTo.trim(), senderSessionId);
  } catch (err) {
    return {
      ok: false,
      message: `mailbox.send payload.to is invalid: ${errMessage(err)}`,
    };
  }
  // The (type, recipient) rule is the SHARED one the agent tools and the HTTP
  // bridge apply (`checkMailboxSendType`). This validator used to re-derive
  // it locally, so the WebSocket surface could accept a pair the mailbox
  // rejects (or reject one it accepts) with a different message.
  const sendTypeCheck = checkMailboxSendType(type, to);
  if (!sendTypeCheck.ok) {
    return {
      ok: false,
      message: `mailbox.send payload.type is invalid: ${sendTypeCheck.error}`,
    };
  }
  if (rawSubject.trim().length > MAILBOX_MAX_SUBJECT_LENGTH) {
    return {
      ok: false,
      message: `mailbox.send payload.subject must be at most ${MAILBOX_MAX_SUBJECT_LENGTH} characters`,
    };
  }
  if (rawBody.trim().length > MAILBOX_MAX_BODY_LENGTH) {
    return {
      ok: false,
      message: `mailbox.send payload.body must be at most ${MAILBOX_MAX_BODY_LENGTH} characters`,
    };
  }

  return {
    ok: true,
    value: {
      requestId: requestId.trim(),
      ...(rawFrom !== undefined ? { from: rawFrom.trim() } : {}),
      to,
      type,
      audience: rawAudience,
      subject: rawSubject.trim(),
      body: rawBody.trim(),
      priority: rawPriority,
      ...(trimmedReplyTo.length > 0 ? { replyTo: trimmedReplyTo } : {}),
      ...(senderSessionId !== undefined ? { sessionId: senderSessionId } : {}),
    },
  };
}

export function validateMailboxAgentsPayload(
  payload: unknown,
): PayloadValidationResult<MailboxAgentsPayload | undefined> {
  if (payload === undefined) return { ok: true, value: undefined };
  if (!isRecord(payload)) {
    return { ok: false, message: 'mailbox.agents payload must be an object when provided' };
  }
  const onlineOnly = payload['onlineOnly'];
  if (onlineOnly !== undefined && typeof onlineOnly !== 'boolean') {
    return {
      ok: false,
      message: 'mailbox.agents payload.onlineOnly must be a boolean when provided',
    };
  }
  return {
    ok: true,
    value: { ...(onlineOnly !== undefined ? { onlineOnly: onlineOnly as boolean } : {}) },
  };
}

interface MailboxPurgePayload {
  completedMaxAgeMs?: number;
  incompleteMaxAgeMs?: number;
}

export function validateMailboxPurgePayload(
  payload: unknown,
): PayloadValidationResult<MailboxPurgePayload | undefined> {
  if (payload === undefined) return { ok: true, value: undefined };
  if (!isRecord(payload)) {
    return { ok: false, message: 'mailbox.purge payload must be an object when provided' };
  }
  const completedMaxAgeMs = payload['completedMaxAgeMs'];
  const incompleteMaxAgeMs = payload['incompleteMaxAgeMs'];
  if (
    completedMaxAgeMs !== undefined &&
    (typeof completedMaxAgeMs !== 'number' ||
      !Number.isFinite(completedMaxAgeMs) ||
      completedMaxAgeMs < 0)
  ) {
    return {
      ok: false,
      message:
        'mailbox.purge payload.completedMaxAgeMs must be a non-negative number when provided',
    };
  }
  if (
    incompleteMaxAgeMs !== undefined &&
    (typeof incompleteMaxAgeMs !== 'number' ||
      !Number.isFinite(incompleteMaxAgeMs) ||
      incompleteMaxAgeMs < 0)
  ) {
    return {
      ok: false,
      message:
        'mailbox.purge payload.incompleteMaxAgeMs must be a non-negative number when provided',
    };
  }
  return {
    ok: true,
    value: {
      ...(completedMaxAgeMs !== undefined
        ? { completedMaxAgeMs: completedMaxAgeMs as number }
        : {}),
      ...(incompleteMaxAgeMs !== undefined
        ? { incompleteMaxAgeMs: incompleteMaxAgeMs as number }
        : {}),
    },
  };
}
