import type {
  TrustActor,
  TrustAuthContext,
  TrustBoundary,
  TrustBoundaryDecision,
  TrustBoundaryRequest,
  TrustRisk,
  TrustScope,
  TrustSubject,
} from '@wrongstack/core/security';
import type { PermissionOption, RequestPermissionOutcome, ToolKind } from '../types/acp-v1.js';
import type { PermissionPolicy, PermissionRequest } from './permission.js';

export interface ACPTrustBoundaryAdapterOptions {
  boundary: TrustBoundary;
  actor?: TrustActor | undefined;
  scope?: TrustScope | undefined;
  authContext?: TrustAuthContext | undefined;
}

function pickOption(
  options: readonly PermissionOption[],
  allowed: boolean,
): RequestPermissionOutcome {
  const kinds = allowed ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always'];
  for (const kind of kinds) {
    const option = options.find((candidate) => candidate.kind === kind);
    if (option) return { outcome: 'selected', optionId: option.optionId };
  }
  return { outcome: 'cancelled' };
}

function riskFor(kind: ToolKind | undefined): TrustRisk {
  if (kind === 'read' || kind === 'search' || kind === 'fetch' || kind === 'think') return 'low';
  if (kind === 'edit' || kind === 'move') return 'elevated';
  if (kind === 'delete' || kind === 'execute') return 'high';
  return 'elevated';
}

function capabilityFor(request: PermissionRequest): string {
  const raw = request.toolCall.rawInput;
  if (typeof raw?.path === 'string') {
    return request.toolCall.kind === 'read' || request.toolCall.kind === 'search'
      ? 'filesystem.read'
      : 'filesystem.write';
  }
  if (typeof raw?.command === 'string' || request.toolCall.kind === 'execute')
    return 'process.spawn';
  if (request.toolCall.kind === 'fetch') return 'network.fetch';
  return `tool.${request.toolCall.kind ?? 'unknown'}`;
}

function subjectFor(request: PermissionRequest): TrustSubject {
  const raw = request.toolCall.rawInput;
  const title = request.toolCall.title ?? `ACP tool call ${String(request.toolCall.toolCallId)}`;
  if (typeof raw?.path === 'string') {
    return { kind: 'path', id: raw.path, attributes: { toolKind: request.toolCall.kind ?? null } };
  }
  if (typeof raw?.command === 'string') {
    return {
      kind: 'command',
      id: raw.command,
      attributes: { toolKind: request.toolCall.kind ?? null },
    };
  }
  return {
    kind: 'resource',
    id: title,
    attributes: { toolKind: request.toolCall.kind ?? null },
  };
}

function isAllowed(decision: TrustBoundaryDecision): boolean {
  return decision.kind === 'allow' || decision.kind === 'scoped-token';
}

export function toTrustBoundaryRequest(
  request: PermissionRequest,
  options: Omit<ACPTrustBoundaryAdapterOptions, 'boundary'>,
): TrustBoundaryRequest {
  const rawSessionId = request.toolCall.rawInput?.sessionId;
  const sessionId =
    typeof rawSessionId === 'string' && rawSessionId.length > 0
      ? rawSessionId
      : options.actor?.sessionId;
  return {
    version: 1,
    requestId: String(request.toolCall.toolCallId),
    actor: {
      ...(options.actor ?? { kind: 'agent' as const }),
      ...(sessionId ? { sessionId } : {}),
    },
    surface: 'acp',
    capability: capabilityFor(request),
    subject: subjectFor(request),
    risk: riskFor(request.toolCall.kind),
    scope: {
      ...(options.scope ?? {}),
      ...(sessionId ? { sessionId } : {}),
    },
    ...(options.authContext ? { authContext: options.authContext } : {}),
    metadata: {
      ...(request.toolCall.title ? { title: request.toolCall.title } : {}),
      toolKind: request.toolCall.kind ?? null,
    },
  };
}

/**
 * Adapts ACP permission callbacks to the shared TrustBoundary authority.
 * `confirm` remains denied here: interactive confirmation belongs in the
 * boundary's host adapter, which must return a final `allow` after consent.
 */
export function makeTrustBoundaryPermissionPolicy(
  options: ACPTrustBoundaryAdapterOptions,
): PermissionPolicy {
  return async (request) => {
    if (request.signal.aborted) return { outcome: 'cancelled' };
    const decision = await options.boundary.evaluate(toTrustBoundaryRequest(request, options));
    if (request.signal.aborted) return { outcome: 'cancelled' };
    return pickOption(request.options, isAllowed(decision));
  };
}

/** Direct-module test seam; not re-exported by the package barrel. */
export const trustBoundaryPermissionCoverage = {
  pickOption,
  riskFor,
  capabilityFor,
  subjectFor,
  isAllowed,
};
