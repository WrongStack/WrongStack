import { randomUUID } from 'node:crypto';
import {
  createCompatibilityTrustBoundary,
  isTrustDecisionAllowed,
  type TrustBoundary,
  type TrustRisk,
  type TrustSubject,
} from '@wrongstack/core/security';
import type { Logger } from '@wrongstack/core/types';

export const desktopCompatibilityTrustBoundary = createCompatibilityTrustBoundary({
  policyId: 'desktop-trusted-host-compat-v1',
  // WS-SEC-03: the desktop shell hosts a renderer that loads *remote* content
  // (the WebUI runtime over http://127.0.0.1). Actions originating there are
  // attributed to `remote-client`, so refuse the high/critical tiers from it —
  // spawning or terminating a runtime is a shell-menu action, never something
  // page content should be able to drive.
  denyHighRiskRemoteClient: true,
});

/**
 * Who asked for this action.
 *
 * `'user'` is a shell-driven action: the application menu, a tray item, or the
 * local `file://` shell renderer we author ourselves. `'remote-client'` is
 * anything reached from the WebUI view, whose content is remote and can be
 * influenced by agent and tool output.
 *
 * WS-SEC-03: this used to be hardcoded to `'user'` for every call, while
 * `createCompatibilityTrustBoundary` only ever denies `remote-client`. Every
 * desktop authorization therefore returned allow no matter what, which made the
 * four gates (spawn / terminate / open-external / open-native) an audit log
 * wearing an enforcement API. The parameter is required rather than defaulted
 * so a new call site has to state its origin instead of silently inheriting the
 * trusted one.
 */
export type DesktopActionOrigin = 'user' | 'remote-client';

export async function authorizeDesktopAction(
  boundary: TrustBoundary,
  action: {
    capability: string;
    subject: TrustSubject;
    risk: TrustRisk;
    origin: DesktopActionOrigin;
    cwd?: string | undefined;
    metadata?: Readonly<Record<string, string | number | boolean | null>> | undefined;
  },
  logger?: Logger,
): Promise<{ allowed: boolean; reason: string }> {
  const principalId = action.origin === 'user' ? 'desktop-user' : 'desktop-webui-view';
  const request = {
    version: 1 as const,
    requestId: randomUUID(),
    actor: { kind: action.origin, id: principalId },
    surface: 'desktop' as const,
    capability: action.capability,
    subject: action.subject,
    risk: action.risk,
    scope: action.cwd ? { cwd: action.cwd } : {},
    authContext: { method: 'local-process' as const, principalId },
    ...(action.metadata ? { metadata: action.metadata } : {}),
  };
  const decision = await boundary.evaluate(request);
  const auditEntry = {
    event: 'desktop.trust_boundary.decision',
    requestId: request.requestId,
    capability: request.capability,
    // The origin is the whole point of the decision now, so an audit line that
    // omits it cannot be used to tell an allowed shell action from an allowed
    // renderer-driven one.
    actor: request.actor.kind,
    decision: decision.kind,
    policyId: decision.policyId,
  };
  if (logger) {
    logger.info('Trust boundary decision', auditEntry);
  } else {
    console.warn(
      JSON.stringify({ level: 'info', ...auditEntry, timestamp: new Date().toISOString() }),
    );
  }
  return { allowed: isTrustDecisionAllowed(decision), reason: decision.reason };
}

export function authorizeDesktopRuntimeStart(
  boundary: TrustBoundary,
  cwd: string,
  runtimeKind: string,
): Promise<{ allowed: boolean; reason: string }> {
  return authorizeDesktopAction(boundary, {
    capability: 'process.spawn',
    // Shell-driven: reached from the app menu / shell renderer's open-project.
    origin: 'user',
    subject: {
      kind: 'command',
      id: 'wrongstack-webui-runtime',
      attributes: { runtimeKind },
    },
    risk: 'high',
    cwd,
    metadata: { operation: 'open-project' },
  });
}

export function authorizeDesktopRuntimeStop(
  boundary: TrustBoundary,
  runtime: { id: string; pid?: number | undefined; root: string },
): Promise<{ allowed: boolean; reason: string }> {
  return authorizeDesktopAction(boundary, {
    capability: 'process.terminate',
    origin: 'user',
    subject: {
      kind: 'process',
      id: runtime.id,
      attributes: {
        ...(runtime.pid !== undefined ? { pid: runtime.pid } : {}),
        runtimeId: runtime.id,
      },
    },
    risk: 'high',
    cwd: runtime.root,
    metadata: { operation: 'close-runtime' },
  });
}
