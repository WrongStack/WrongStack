/**
 * The vault's device routes — no browser credential; what they carry is
 * sealed end to end and authenticated by the device's own keys:
 *   POST /api/vault/enroll   MACed with the one-time code
 *   POST /api/vault/fetch    signed with the device key
 *   POST /api/vault/upload   signed with the device key, sealed to HQ; waits for an operator
 */
import type * as http from 'node:http';
import type {
  HqVaultEnrollRequest,
  HqVaultFetchRequest,
  HqVaultUploadRequest,
} from '@wrongstack/hq';
import type { HqVaultRouteDeps } from './vault-handlers.js';
import { readJsonObject, writeError, writeJson, writeVaultFailure } from './vault-http.js';

export async function handleHqVaultDeviceRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  deps: HqVaultRouteDeps,
): Promise<void> {
  // The vault exists only on an HQ with an operator password; until then
  // there is no code to enroll with and nothing to fetch.
  if (deps.mutableAuth.passwordHash === undefined) {
    writeError(res, 404, 'NOT_FOUND', 'The key vault is not enabled on this HQ.');
    return;
  }
  const body = await readJsonObject(req, res);
  if (!body) return;
  try {
    const store = await deps.vault.store();
    if (pathname === '/api/vault/enroll') {
      writeJson(res, 200, await store.enroll(body as unknown as HqVaultEnrollRequest));
    } else if (pathname === '/api/vault/upload') {
      writeJson(res, 200, await store.uploads().receive(body as unknown as HqVaultUploadRequest));
    } else {
      writeJson(
        res,
        200,
        await store.fetch(body as unknown as HqVaultFetchRequest, {
          refresher: deps.vault.refresher(),
        }),
      );
    }
  } catch (error) {
    writeVaultFailure(res, error);
  }
}
