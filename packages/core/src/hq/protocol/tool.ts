import type { UserInputRequest, UserInputResponse } from '../../types/user-input.js';
import type { HqPathPolicy } from './project.js';

export type HqToolArgsPolicy = 'none' | 'summary' | 'redacted' | 'full';

export interface HqRedactionPolicy {
  rawContent: boolean;
  toolArgs: HqToolArgsPolicy;
  paths: HqPathPolicy;
}

export const DEFAULT_HQ_REDACTION_POLICY: HqRedactionPolicy = {
  rawContent: true,
  toolArgs: 'full',
  paths: 'full',
};

/**
 * Per-string cap applied when redacting chat-transcript events
 * (`session.transcript` / `agent.message`). The generic 500-char summary cap
 * is right for telemetry rollups but would mangle full chat-history rendering
 * in the HQ Console once `rawContent` is enabled — messages and tool outputs
 * routinely exceed it. Applied publisher-side AND at the server's re-redaction
 * so both hops agree.
 */
export const HQ_TRANSCRIPT_TEXT_CAP = 16_000;

export interface HqToolStartedPayload {
  toolName: string;
  capabilities?: readonly string[];
  risk?: string;
  inputSummary?: unknown;
}

export interface HqToolCompletedPayload {
  toolName: string;
  status: 'success' | 'error' | 'timeout' | 'cancelled';
  durationMs: number;
  outputSummary?: unknown;
  errorClass?: string;
}

/**
 * A permission prompt currently on screen somewhere, mirrored to HQ.
 *
 * `inputSummary` goes through the SAME redaction as `tool.started.inputSummary`
 * ({@link summarizeHqToolArgs}); an approval payload must not be the one event
 * that carries raw tool arguments past the redaction plane.
 *
 * `deadlineAt` is load-bearing rather than decorative: a pending approval
 * cannot outlive it (after that the Brain arbiter decides), which is what
 * lets the dashboard derive "still pending" from the event stream alone
 * without a server-side registry.
 */
export interface HqApprovalRequestedPayload {
  toolUseId: string;
  toolName: string;
  /** Redacted argument summary — never raw input. */
  inputSummary?: unknown;
  /** The trust-rule subject an "always" answer would persist. */
  suggestedPattern: string;
  riskTier?: 'safe' | 'standard' | 'destructive';
  decisionSource?: string;
  /** Set when a Kanban governance boundary, not the trust policy, forced the prompt. */
  boundaryReason?: string;
  /** Real write destinations declared by the tool, when it declares any. */
  writeTargets?: readonly string[];
  /** Epoch ms after which the Brain arbiter takes the decision. */
  deadlineAt: number;
  /** Pre-computed so every surface agrees on what counts as a damaging call. */
  destructive: boolean;
}

/** A mirrored prompt that has been settled — by any surface, abort, or timeout. */
export interface HqApprovalResolvedPayload {
  toolUseId: string;
  toolName: string;
  decision: 'yes' | 'no' | 'always' | 'deny' | 'abort';
  source: 'brain_timeout' | 'abort' | 'user';
  rationale?: string;
}

export interface HqUserInputRequestedPayload {
  request: UserInputRequest;
}
export interface HqUserInputResolvedPayload {
  requestId: string;
  response: UserInputResponse;
  source: 'user' | 'abort';
}
