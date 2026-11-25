/** JSON answers and request bodies for the HQ key vault routes. */
import type * as http from 'node:http';
import { HqVaultError } from '@wrongstack/hq';
import { readRequestBody, writeInvalidBody } from '../utils.js';

const BODY_LIMIT = 64 * 1024;

export function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

export function writeError(
  res: http.ServerResponse,
  status: number,
  code: string,
  message: string,
): void {
  writeJson(res, status, { error: { code, message } });
}

const VAULT_ERROR_STATUS: Record<HqVaultError['code'], number> = {
  VAULT_SEALED: 423,
  VAULT_NOT_FOUND: 404,
  VAULT_INVALID: 400,
  VAULT_CONFLICT: 409,
  VAULT_DENIED: 403,
};

export function writeVaultFailure(res: http.ServerResponse, error: unknown): void {
  if (error instanceof HqVaultError) {
    writeJson(res, VAULT_ERROR_STATUS[error.code], {
      ...error.details,
      error: { code: error.code, message: error.message },
    });
    return;
  }
  // Never echo an unexpected error: it could quote file content.
  writeError(res, 500, 'VAULT_ERROR', 'The vault could not complete the request.');
}

export async function readJsonObject(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readRequestBody(req, BODY_LIMIT));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      writeError(res, 400, 'BAD_REQUEST', 'Expected a JSON object.');
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    writeInvalidBody(res, error);
    return undefined;
  }
}
