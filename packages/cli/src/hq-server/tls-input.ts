/**
 * `--tls-cert <path>` / `--tls-key <path>` (or `WRONGSTACK_HQ_TLS_CERT` /
 * `WRONGSTACK_HQ_TLS_KEY`): PEM files that make HQ serve HTTPS/WSS itself.
 *
 * Shared by every HQ entry point (`wstack hq`, `wstack --hq`) so they accept
 * the same inputs and refuse the same mistakes. Both halves or neither: a
 * certificate without its key is an operator error, never a silent fallback
 * to plain HTTP.
 */
import * as fs from 'node:fs/promises';

export type HqTlsInput =
  | { ok: true; tls?: { cert: Buffer; key: Buffer } }
  | { ok: false; error: string };

function pick(
  flags: Record<string, string | boolean>,
  flag: string,
  env: NodeJS.ProcessEnv,
  envName: string,
): string | undefined {
  const fromFlag = flags[flag];
  if (fromFlag === true) return '';
  const value = typeof fromFlag === 'string' ? fromFlag : env[envName];
  return value === undefined ? undefined : value.trim();
}

export async function resolveHqTlsInput(
  flags: Record<string, string | boolean>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<HqTlsInput> {
  const certPath = pick(flags, 'tls-cert', env, 'WRONGSTACK_HQ_TLS_CERT');
  const keyPath = pick(flags, 'tls-key', env, 'WRONGSTACK_HQ_TLS_KEY');
  if (certPath === undefined && keyPath === undefined) return { ok: true };
  if (!certPath || !keyPath) {
    return { ok: false, error: 'HQ TLS needs both --tls-cert <path> and --tls-key <path>.' };
  }
  let cert: Buffer;
  let key: Buffer;
  try {
    cert = await fs.readFile(certPath);
  } catch (cause) {
    return { ok: false, error: `Cannot read --tls-cert ${certPath}: ${(cause as Error).message}` };
  }
  try {
    key = await fs.readFile(keyPath);
  } catch (cause) {
    return { ok: false, error: `Cannot read --tls-key ${keyPath}: ${(cause as Error).message}` };
  }
  if (!cert.includes('-----BEGIN CERTIFICATE-----')) {
    return { ok: false, error: `--tls-cert ${certPath} is not a PEM certificate.` };
  }
  if (!/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/.test(key.toString('utf8'))) {
    return { ok: false, error: `--tls-key ${keyPath} is not a PEM private key.` };
  }
  return { ok: true, tls: { cert, key } };
}
