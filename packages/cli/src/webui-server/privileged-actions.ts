import { randomUUID } from 'node:crypto';
import {
  isTrustDecisionAllowed,
  type TrustBoundary,
  type TrustRisk,
  type TrustSubject,
} from '@wrongstack/core/security';
import {
  handleProcessKill,
  handleProcessKillAll,
  handleProcessList,
  type ProcessRouteHandlers,
} from '@wrongstack/webui-server';

export async function authorizeCliWebUIAction(
  boundary: TrustBoundary,
  action: {
    capability: string;
    subject: TrustSubject;
    risk: TrustRisk;
    cwd?: string | undefined;
    metadata?: Readonly<Record<string, string | number | boolean | null>> | undefined;
  },
): Promise<{ allowed: boolean; reason: string }> {
  const decision = await boundary.evaluate({
    version: 1,
    requestId: randomUUID(),
    actor: { kind: 'remote-client' },
    surface: 'webui',
    capability: action.capability,
    subject: action.subject,
    risk: action.risk,
    scope: action.cwd ? { cwd: action.cwd } : {},
    authContext: { method: 'session' },
    metadata: { backend: 'cli-embedded', ...(action.metadata ?? {}) },
  });
  return { allowed: isTrustDecisionAllowed(decision), reason: decision.reason };
}

export function createCliProcessRoutes(boundary: TrustBoundary): ProcessRouteHandlers {
  return {
    list: (ws, message) => handleProcessList(ws, message),
    kill: (ws, message) =>
      handleProcessKill(ws, message.payload, boundary, undefined, { backend: 'cli-embedded' }),
    killAll: (ws, message) =>
      handleProcessKillAll(ws, boundary, undefined, { backend: 'cli-embedded' }, message.payload),
  };
}
