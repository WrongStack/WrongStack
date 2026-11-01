/**
 * Alert thresholds, daily budgets and snoozes.
 *
 *   GET    /api/alerts/settings                 thresholds, base, snoozes, 24h spend
 *   PUT    /api/alerts/settings                 save thresholds        (auth.admin)
 *   POST   /api/alerts/rules/:ruleId/snooze     { minutes }            (control.enqueue)
 *   DELETE /api/alerts/rules/:ruleId/snooze     end a snooze           (control.enqueue)
 *
 * Changing what alerts at all is an admin act; muting one rule for a while is
 * an operator act, at the same level as steering a session.
 */
import type * as http from 'node:http';
import type { HqNotifier } from '@wrongstack/hq';
import type { HqAlertSettings, HqAlertSettingsOutcome } from '../alert-settings.js';
import { authenticateBrowserRequest, hqAuthRequired } from '../auth.js';
import type { HqRouterMutableAuth, HqSessionEntry } from '../types.js';
import { readRequestBody, writeInvalidBody } from '../utils.js';
import { requireAdminCredential } from './auth/common.js';
import { handleApiMachineTokens, type MachineTokenDeps } from './machine-token-handlers.js';
import { callerCanEnqueue } from './mailbox-handlers.js';
import { handleApiNotify } from './notify-handlers.js';

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function writeOutcome<T>(res: http.ServerResponse, outcome: HqAlertSettingsOutcome<T>): void {
  if (outcome.ok) writeJson(res, 200, outcome.value);
  else writeJson(res, outcome.status, { error: outcome.error });
}

/** True when the request was routed here. */
export async function handleApiAlertSettings(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  deps: {
    settings: HqAlertSettings;
    mutableAuth: HqRouterMutableAuth;
    sessions: Map<string, HqSessionEntry>;
  },
): Promise<boolean> {
  const settingsPath = url.pathname === '/api/alerts/settings';
  const snoozeMatch = url.pathname.match(/^\/api\/alerts\/rules\/([^/]{1,600})\/snooze$/);
  if (!settingsPath && !snoozeMatch) return false;

  const auth = authenticateBrowserRequest(req, url, deps.mutableAuth, deps.sessions);
  if (hqAuthRequired(deps.mutableAuth) && !auth) {
    writeJson(res, 401, { error: 'unauthorized' });
    return true;
  }
  const readBody = async (): Promise<Record<string, unknown> | null> => {
    try {
      const parsed: unknown = JSON.parse(await readRequestBody(req));
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      writeJson(res, 400, { error: 'expected a JSON object' });
    } catch (error) {
      writeInvalidBody(res, error);
    }
    return null;
  };

  if (settingsPath) {
    if (req.method === 'GET') {
      writeJson(res, 200, deps.settings.view());
      return true;
    }
    if (req.method === 'PUT') {
      if (!requireAdminCredential(res, auth)) return true;
      const body = await readBody();
      if (body !== null) writeOutcome(res, await deps.settings.updateThresholds(body.thresholds));
      return true;
    }
    writeJson(res, 405, { error: 'method not allowed' });
    return true;
  }

  if (!callerCanEnqueue(auth, deps.mutableAuth)) {
    writeJson(res, 403, { error: 'forbidden: token lacks control.enqueue capability' });
    return true;
  }
  let ruleId: string;
  try {
    ruleId = decodeURIComponent(snoozeMatch![1]!);
  } catch {
    writeJson(res, 400, { error: 'invalid rule id' });
    return true;
  }
  if (req.method === 'POST') {
    const body = await readBody();
    if (body !== null) writeOutcome(res, await deps.settings.snooze(ruleId, body.minutes));
    return true;
  }
  if (req.method === 'DELETE') {
    writeOutcome(res, await deps.settings.unsnooze(ruleId));
    return true;
  }
  writeJson(res, 405, { error: 'method not allowed' });
  return true;
}

/** Operator settings routes: notification channels, then alert settings. */
export async function handleApiOperatorSettings(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  deps: {
    notifier?: HqNotifier | undefined;
    alertSettings?: HqAlertSettings | undefined;
    mutableAuth: HqRouterMutableAuth;
    sessions: Map<string, HqSessionEntry>;
    /** Present when the router can mint client tokens (`/api/machine-tokens`). */
    machineTokens?: Omit<MachineTokenDeps, 'mutableAuth' | 'sessions'> | undefined;
  },
): Promise<boolean> {
  const { notifier, alertSettings, mutableAuth, sessions } = deps;
  if (
    deps.machineTokens !== undefined &&
    (await handleApiMachineTokens(req, res, url, { ...deps.machineTokens, mutableAuth, sessions }))
  ) {
    return true;
  }
  if (
    notifier !== undefined &&
    (await handleApiNotify(req, res, url, { notifier, mutableAuth, sessions }))
  ) {
    return true;
  }
  return (
    alertSettings !== undefined &&
    (await handleApiAlertSettings(req, res, url, {
      settings: alertSettings,
      mutableAuth,
      sessions,
    }))
  );
}
