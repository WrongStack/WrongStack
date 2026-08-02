import type { HqCommand } from '@wrongstack/core/hq';
import {
  isTrustDecisionAllowed,
  type TrustBoundary,
  type TrustBoundaryRequest,
} from '@wrongstack/core/security';
import type { ConnectedClient } from './types.js';

export async function authorizeHqCommand(input: {
  boundary: TrustBoundary;
  command: HqCommand;
  commandId: string;
  enqueuedBy: string;
  authMethod: 'session' | 'bearer-token';
  target: ConnectedClient;
}): Promise<{ allowed: boolean; reason: string }> {
  const { boundary, command, commandId, enqueuedBy, authMethod, target } = input;
  const subject =
    command.type === 'run-command'
      ? {
          kind: 'command' as const,
          id: command.command,
          attributes: { targetClientId: target.clientId },
        }
      : {
          kind: 'custom' as const,
          id: command.type,
          attributes: { targetClientId: target.clientId },
        };
  const request: TrustBoundaryRequest = {
    version: 1,
    requestId: commandId,
    // WS-050: this was hardcoded to `kind: 'user'`, which made the
    // compatibility policy's ONLY deny rule — `remote-client` + `critical` —
    // unreachable from HQ. A boundary whose single rule can never fire is not
    // defence in depth, it is decoration.
    //
    // The provenance is derived from how the caller authenticated, because
    // that is the honest signal available here:
    //
    //   session cookie → `user`. The dashboard's primary flow is a bootstrap
    //     code exchanged for an HttpOnly cookie, so this is a human at the
    //     browser. NOTE: bootstrap sessions DO carry a `tokenId`, so a
    //     "cookie without tokenId" test would have misclassified every normal
    //     dashboard user as remote and denied them run-command. Checked before
    //     writing this, not assumed.
    //   raw bearer token → `remote-client`. The legacy `?token=` / manual-entry
    //     path and any script calling the HTTP API directly. A credential that
    //     can be copied into a script is not a person at a console.
    //
    // Consequence, deliberate: a bearer-token caller can no longer trigger
    // `run-command` (the only `critical` capability here). `enqueue` is `high`
    // and unaffected. The migration for automation that needs execute is the
    // bootstrap exchange, which is the same thing the dashboard does.
    actor: { kind: authMethod === 'session' ? 'user' : 'remote-client', id: enqueuedBy },
    surface: 'hq',
    capability: command.type === 'run-command' ? 'hq.control.execute' : 'hq.control.enqueue',
    subject,
    risk: command.type === 'run-command' ? 'critical' : 'high',
    scope: { projectId: target.projectId },
    authContext: { method: authMethod, principalId: enqueuedBy },
    metadata: { commandType: command.type, targetKind: target.kind },
  };
  const decision = await boundary.evaluate(request);
  console.warn(
    JSON.stringify({
      level: 'info',
      event: 'hq.trust_boundary.decision',
      requestId: commandId,
      capability: request.capability,
      decision: decision.kind,
      policyId: decision.policyId,
      actor: enqueuedBy,
      clientId: target.clientId,
      timestamp: new Date().toISOString(),
    }),
  );
  return { allowed: isTrustDecisionAllowed(decision), reason: decision.reason };
}
