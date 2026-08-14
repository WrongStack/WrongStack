import type { MailboxMessage } from './mailbox-types.js';

function isAffectedBySessionAffinity(message: Pick<MailboxMessage, 'sessionAffinity'>): boolean {
  return message.sessionAffinity !== undefined;
}

function isPromiseLike<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

function maybeSyncResolveChimeraReportSessionId(
  result: string | undefined | PromiseLike<string | undefined>,
): string | undefined {
  if (!isPromiseLike(result)) return result;
  try {
    result.then(undefined, () => undefined);
  } catch {
    // Malformed thenables must not propagate out of the sync mailbox filter.
  }
  return undefined;
}

export interface MailboxSessionAffinityContext {
  resolveChimeraReportSessionId?:
    | ((reportId: string) => string | undefined | Promise<string | undefined>)
    | undefined;
  allowUnscoped?: boolean | undefined;
}

export async function acceptMailboxMessageForSession(
  message: Pick<MailboxMessage, 'type' | 'sessionAffinity'>,
  currentSessionId: string | undefined,
  ctx?: MailboxSessionAffinityContext,
): Promise<boolean> {
  if (!isAffectedBySessionAffinity(message)) return true;
  const affinity = message.sessionAffinity!;
  if (affinity === null || typeof affinity !== 'object' || Array.isArray(affinity)) {
    return false;
  }
  if (
    (affinity.sessionId !== undefined && typeof affinity.sessionId !== 'string') ||
    (affinity.reportId !== undefined && typeof affinity.reportId !== 'string')
  ) {
    return false;
  }
  if (!currentSessionId) {
    return ctx?.allowUnscoped === true;
  }
  if (typeof affinity.sessionId === 'string' && affinity.sessionId.length > 0) {
    if (affinity.sessionId !== currentSessionId) return false;
    return true;
  }
  if (affinity.reportId && ctx?.resolveChimeraReportSessionId) {
    try {
      const resolved = await ctx.resolveChimeraReportSessionId(affinity.reportId);
      if (resolved === currentSessionId) return true;
      if (resolved !== undefined) return false;
    } catch {
      // Fall through to allowUnscoped
    }
  }
  if (ctx?.allowUnscoped === true) return true;
  return false;
}

export function acceptMailboxMessageForSessionSync(
  message: Pick<MailboxMessage, 'type' | 'sessionAffinity'>,
  currentSessionId: string | undefined,
  ctx?: MailboxSessionAffinityContext,
): boolean {
  if (!isAffectedBySessionAffinity(message)) return true;
  const affinity = message.sessionAffinity!;
  if (affinity === null || typeof affinity !== 'object' || Array.isArray(affinity)) {
    return false;
  }
  if (!currentSessionId) {
    return ctx?.allowUnscoped === true;
  }
  if (typeof affinity.sessionId === 'string' && affinity.sessionId.length > 0) {
    if (affinity.sessionId !== currentSessionId) return false;
    return true;
  }
  if (affinity.reportId && ctx?.resolveChimeraReportSessionId) {
    try {
      const rawResult = ctx.resolveChimeraReportSessionId(affinity.reportId) as
        | string
        | undefined
        | Promise<string | undefined>;
      const syncResult = maybeSyncResolveChimeraReportSessionId(rawResult);
      if (syncResult === currentSessionId) return true;
      if (syncResult !== undefined) return false;
    } catch {
      // Ignored
    }
  }
  if (ctx?.allowUnscoped === true) return true;
  return false;
}
