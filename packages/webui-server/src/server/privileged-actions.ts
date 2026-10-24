import { randomUUID } from 'node:crypto';
import type { Logger } from '@wrongstack/contracts/types';
import {
  isTrustDecisionAllowed,
  type TrustBoundary,
  type TrustBoundaryRequest,
  type TrustRisk,
  type TrustSubject,
} from '@wrongstack/core/security';

export interface WebUIPrivilegedAction {
  capability: string;
  subject: TrustSubject;
  risk: TrustRisk;
  cwd?: string | undefined;
  sessionId?: string | undefined;
  metadata?: TrustBoundaryRequest['metadata'] | undefined;
}

export async function authorizeWebUIAction(
  boundary: TrustBoundary,
  action: WebUIPrivilegedAction,
  logger?: Logger | undefined,
): Promise<{ allowed: boolean; reason: string; request: TrustBoundaryRequest }> {
  const request: TrustBoundaryRequest = {
    version: 1,
    requestId: randomUUID(),
    actor: {
      kind: 'remote-client',
      ...(action.sessionId ? { sessionId: action.sessionId } : {}),
    },
    surface: 'webui',
    capability: action.capability,
    subject: action.subject,
    risk: action.risk,
    scope: {
      ...(action.cwd ? { cwd: action.cwd } : {}),
      ...(action.sessionId ? { sessionId: action.sessionId } : {}),
    },
    authContext: { method: 'session' },
    ...(action.metadata ? { metadata: action.metadata } : {}),
  };
  const decision = await boundary.evaluate(request);
  logger?.debug?.(
    `[trust-boundary] ${request.capability} ${decision.kind} request=${request.requestId}`,
  );
  return { allowed: isTrustDecisionAllowed(decision), reason: decision.reason, request };
}
