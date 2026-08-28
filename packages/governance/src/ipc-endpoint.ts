import { createHash } from 'node:crypto';
import * as path from 'node:path';

import { GOVERNANCE_SERVICE_PROTOCOL_VERSION } from './service-protocol.js';

const GOVERNANCE_DATABASE_RELATIVE_PATH = path.join(
  '.wrongstack',
  'governance',
  'governance.sqlite',
);

export function canonicalGovernanceProjectRoot(projectRoot: string): string {
  const resolved = path.resolve(projectRoot);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function governanceProjectKey(projectRoot: string): string {
  return createHash('sha256')
    .update(canonicalGovernanceProjectRoot(projectRoot))
    .digest('hex')
    .slice(0, 24);
}

export function governanceProjectServerEndpoint(projectRoot: string): string {
  const key = governanceProjectKey(projectRoot);
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\wrongstack-governance-v${GOVERNANCE_SERVICE_PROTOCOL_VERSION}-${key}`;
  }
  const temporaryRoot = process.env['TMPDIR'] ?? '/tmp';
  return path.join(temporaryRoot, `wsgov-v${GOVERNANCE_SERVICE_PROTOCOL_VERSION}`, `${key}.sock`);
}

export function governanceProjectDatabasePath(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), GOVERNANCE_DATABASE_RELATIVE_PATH);
}
