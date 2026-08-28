import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as path from 'node:path';
import type { GovernanceServiceCredential } from './capability-grant.js';
import {
  canonicalGovernanceProjectRoot,
  governanceProjectKey,
  governanceProjectServerEndpoint,
} from './ipc-endpoint.js';
import { GOVERNANCE_SERVICE_PROTOCOL_VERSION } from './service-protocol.js';

const GOVERNANCE_DAEMON_METADATA_SCHEMA_VERSION = 1 as const;
const GOVERNANCE_DAEMON_STARTUP_LEASE_SCHEMA_VERSION = 1 as const;
const GOVERNANCE_DAEMON_ATTACHMENT_BROKER_SCHEMA_VERSION = 1 as const;
const GOVERNANCE_DAEMON_METADATA_MAX_BYTES = 64 * 1024;
const GOVERNANCE_DAEMON_ENDPOINT_PROBE_TIMEOUT_MS = 750;
const GOVERNANCE_DAEMON_STARTUP_LEASE_TIMEOUT_MS = 10_000;
const GOVERNANCE_DAEMON_STARTUP_LEASE_RETRY_MS = 50;
export const GOVERNANCE_DAEMON_ATTACHMENT_BROKER_TTL_MS = 60 * 60 * 1_000;

const GOVERNANCE_DAEMON_METADATA_RELATIVE_PATH = path.join(
  '.wrongstack',
  'governance',
  'daemon.json',
);
const GOVERNANCE_DAEMON_STARTUP_LEASE_RELATIVE_PATH = path.join(
  '.wrongstack',
  'governance',
  'daemon-startup.lock',
);
const GOVERNANCE_DAEMON_ATTACHMENT_BROKER_RELATIVE_PATH = path.join(
  '.wrongstack',
  'governance',
  'attachment-broker.json',
);

export interface GovernanceDaemonMetadata {
  readonly schemaVersion: typeof GOVERNANCE_DAEMON_METADATA_SCHEMA_VERSION;
  readonly protocolVersion: typeof GOVERNANCE_SERVICE_PROTOCOL_VERSION;
  readonly projectKey: string;
  readonly projectRoot: string;
  readonly projectId: string;
  readonly endpoint: string;
  readonly pid: number;
  readonly instanceId: string;
  readonly startedAt: string;
}

interface GovernanceDaemonStartupLeaseRecord {
  readonly schemaVersion: typeof GOVERNANCE_DAEMON_STARTUP_LEASE_SCHEMA_VERSION;
  readonly projectKey: string;
  readonly pid: number;
  readonly instanceId: string;
  readonly startedAt: string;
}

export interface GovernanceDaemonAttachmentBrokerRecord {
  readonly schemaVersion: typeof GOVERNANCE_DAEMON_ATTACHMENT_BROKER_SCHEMA_VERSION;
  readonly protocolVersion: typeof GOVERNANCE_SERVICE_PROTOCOL_VERSION;
  readonly projectKey: string;
  readonly projectRoot: string;
  readonly projectId: string;
  readonly pid: number;
  readonly instanceId: string;
  readonly grantId: string;
  readonly expiresAt: string;
  readonly credential: GovernanceServiceCredential;
}

type GovernanceDaemonAttachmentBrokerReadResult =
  | { readonly kind: 'missing' }
  | { readonly kind: 'invalid'; readonly reason: string }
  | { readonly kind: 'valid'; readonly broker: GovernanceDaemonAttachmentBrokerRecord };

type GovernanceDaemonMetadataReadResult =
  | { readonly kind: 'missing' }
  | { readonly kind: 'invalid'; readonly reason: string }
  | { readonly kind: 'valid'; readonly metadata: GovernanceDaemonMetadata };

type GovernanceDaemonInspection =
  | { readonly kind: 'live'; readonly metadata: GovernanceDaemonMetadata }
  | {
      readonly kind: 'stale';
      readonly metadata: GovernanceDaemonMetadata | null;
      readonly metadataState: 'missing' | 'invalid' | 'dead-owner';
    }
  | {
      readonly kind: 'endpoint_invalid';
      readonly metadata: GovernanceDaemonMetadata | null;
      readonly reason: string;
    };

type GovernanceDaemonStartupLeaseErrorCode = 'busy' | 'invalid_lease';

export class GovernanceDaemonStartupLeaseError extends Error {
  constructor(
    readonly code: GovernanceDaemonStartupLeaseErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'GovernanceDaemonStartupLeaseError';
  }
}

interface AcquireGovernanceDaemonStartupLeaseOptions {
  readonly projectRoot: string;
  readonly pid: number;
  readonly instanceId: string;
  readonly startedAt: string;
  readonly timeoutMs?: number | undefined;
  readonly retryMs?: number | undefined;
  readonly now?: (() => number) | undefined;
  readonly isProcessAlive?: ((pid: number) => boolean) | undefined;
}

interface JsonRecord {
  readonly [key: string]: unknown;
}

function plainRecord(value: unknown): JsonRecord | null {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    return null;
  }
  return value as JsonRecord;
}

function exactKeys(record: JsonRecord, expected: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function tokenSafe(value: unknown, maxLength = 128): value is string {
  return (
    typeof value === 'string' && new RegExp(`^[A-Za-z0-9_-]{1,${maxLength}}$`, 'u').test(value)
  );
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value));
}

function validPid(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

async function ensurePrivateDirectory(projectRoot: string): Promise<string> {
  const root = await fs.stat(projectRoot);
  if (!root.isDirectory()) throw new Error('Governance project root must be a directory.');
  const directory = path.dirname(governanceDaemonMetadataPath(projectRoot));
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await fs.chmod(directory, 0o700);
  return directory;
}

async function readBounded(pathname: string): Promise<string | null> {
  try {
    const value = await fs.readFile(pathname);
    if (value.byteLength > GOVERNANCE_DAEMON_METADATA_MAX_BYTES) {
      throw new Error(
        `Governance daemon metadata exceeds ${GOVERNANCE_DAEMON_METADATA_MAX_BYTES} bytes.`,
      );
    }
    return value.toString('utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }
}

function parseMetadata(raw: string, projectRoot: string): GovernanceDaemonMetadataReadResult {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return { kind: 'invalid', reason: 'Metadata is not valid JSON.' };
  }
  const record = plainRecord(value);
  const expectedKeys = [
    'endpoint',
    'instanceId',
    'pid',
    'projectId',
    'projectKey',
    'projectRoot',
    'protocolVersion',
    'schemaVersion',
    'startedAt',
  ];
  if (!record || !exactKeys(record, expectedKeys)) {
    return { kind: 'invalid', reason: 'Metadata fields do not match the strict schema.' };
  }
  if (
    record.schemaVersion !== GOVERNANCE_DAEMON_METADATA_SCHEMA_VERSION ||
    record.protocolVersion !== GOVERNANCE_SERVICE_PROTOCOL_VERSION ||
    record.projectKey !== governanceProjectKey(projectRoot) ||
    record.projectRoot !== canonicalGovernanceProjectRoot(projectRoot) ||
    record.endpoint !== governanceProjectServerEndpoint(projectRoot) ||
    typeof record.projectId !== 'string' ||
    record.projectId.trim().length === 0 ||
    record.projectId.length > 512 ||
    !validPid(record.pid) ||
    !tokenSafe(record.instanceId) ||
    !validTimestamp(record.startedAt)
  ) {
    return { kind: 'invalid', reason: 'Metadata identity or value validation failed.' };
  }
  return { kind: 'valid', metadata: Object.freeze(record as unknown as GovernanceDaemonMetadata) };
}

function parseLease(raw: string, projectRoot: string): GovernanceDaemonStartupLeaseRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  const record = plainRecord(value);
  const expectedKeys = ['instanceId', 'pid', 'projectKey', 'schemaVersion', 'startedAt'];
  if (
    !record ||
    !exactKeys(record, expectedKeys) ||
    record.schemaVersion !== GOVERNANCE_DAEMON_STARTUP_LEASE_SCHEMA_VERSION ||
    record.projectKey !== governanceProjectKey(projectRoot) ||
    !validPid(record.pid) ||
    !tokenSafe(record.instanceId) ||
    !validTimestamp(record.startedAt)
  ) {
    return null;
  }
  return Object.freeze(record as unknown as GovernanceDaemonStartupLeaseRecord);
}

function parseAttachmentBroker(
  raw: string,
  projectRoot: string,
): GovernanceDaemonAttachmentBrokerReadResult {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return { kind: 'invalid', reason: 'Attachment broker record is not valid JSON.' };
  }
  const record = plainRecord(value);
  const credential = record ? plainRecord(record.credential) : null;
  const expectedKeys = [
    'credential',
    'expiresAt',
    'grantId',
    'instanceId',
    'pid',
    'projectId',
    'projectKey',
    'projectRoot',
    'protocolVersion',
    'schemaVersion',
  ];
  if (
    !record ||
    !exactKeys(record, expectedKeys) ||
    !credential ||
    !exactKeys(credential, ['clientId', 'projectId', 'token'])
  ) {
    return { kind: 'invalid', reason: 'Attachment broker fields do not match the strict schema.' };
  }
  const token = credential.token;
  const tokenPrefix = `wsg_${String(record.grantId)}.`;
  const tokenSecret = typeof token === 'string' ? token.slice(tokenPrefix.length) : '';
  if (
    record.schemaVersion !== GOVERNANCE_DAEMON_ATTACHMENT_BROKER_SCHEMA_VERSION ||
    record.protocolVersion !== GOVERNANCE_SERVICE_PROTOCOL_VERSION ||
    record.projectKey !== governanceProjectKey(projectRoot) ||
    record.projectRoot !== canonicalGovernanceProjectRoot(projectRoot) ||
    typeof record.projectId !== 'string' ||
    record.projectId.trim().length === 0 ||
    record.projectId.length > 512 ||
    !validPid(record.pid) ||
    !tokenSafe(record.instanceId) ||
    !tokenSafe(record.grantId) ||
    !validTimestamp(record.expiresAt) ||
    credential.projectId !== record.projectId ||
    typeof credential.clientId !== 'string' ||
    credential.clientId.trim().length === 0 ||
    credential.clientId.length > 512 ||
    typeof token !== 'string' ||
    token.length > 700 ||
    !token.startsWith(tokenPrefix) ||
    !/^[A-Za-z0-9_-]{32,512}$/u.test(tokenSecret)
  ) {
    return { kind: 'invalid', reason: 'Attachment broker identity or value validation failed.' };
  }
  return {
    kind: 'valid',
    broker: Object.freeze({
      ...(record as unknown as GovernanceDaemonAttachmentBrokerRecord),
      credential: Object.freeze({ ...(credential as unknown as GovernanceServiceCredential) }),
    }),
  };
}

async function removeIfUnchanged(pathname: string, expected: string): Promise<boolean> {
  const current = await readBounded(pathname);
  if (current === null || current !== expected) return false;
  try {
    await fs.rm(pathname, { force: true });
    return true;
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function governanceDaemonMetadataPath(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), GOVERNANCE_DAEMON_METADATA_RELATIVE_PATH);
}

export function governanceDaemonStartupLeasePath(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), GOVERNANCE_DAEMON_STARTUP_LEASE_RELATIVE_PATH);
}

export function governanceDaemonAttachmentBrokerPath(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), GOVERNANCE_DAEMON_ATTACHMENT_BROKER_RELATIVE_PATH);
}

export function createGovernanceDaemonAttachmentBroker(options: {
  readonly metadata: GovernanceDaemonMetadata;
  readonly grantId: string;
  readonly expiresAt: string;
  readonly credential: GovernanceServiceCredential;
}): GovernanceDaemonAttachmentBrokerRecord {
  const broker: GovernanceDaemonAttachmentBrokerRecord = {
    schemaVersion: GOVERNANCE_DAEMON_ATTACHMENT_BROKER_SCHEMA_VERSION,
    protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
    projectKey: options.metadata.projectKey,
    projectRoot: options.metadata.projectRoot,
    projectId: options.metadata.projectId,
    pid: options.metadata.pid,
    instanceId: options.metadata.instanceId,
    grantId: options.grantId,
    expiresAt: options.expiresAt,
    credential: Object.freeze({ ...options.credential }),
  };
  const validated = parseAttachmentBroker(JSON.stringify(broker), options.metadata.projectRoot);
  if (validated.kind !== 'valid') {
    throw new Error(
      validated.kind === 'invalid'
        ? validated.reason
        : 'Governance attachment broker record is missing.',
    );
  }
  return validated.broker;
}

export async function writeGovernanceDaemonAttachmentBroker(
  projectRoot: string,
  broker: GovernanceDaemonAttachmentBrokerRecord,
): Promise<void> {
  const validated = parseAttachmentBroker(JSON.stringify(broker), projectRoot);
  if (validated.kind !== 'valid') {
    throw new Error(
      validated.kind === 'invalid'
        ? validated.reason
        : 'Governance attachment broker record is missing.',
    );
  }
  const expected = validated.broker;
  await ensurePrivateDirectory(projectRoot);
  const pathname = governanceDaemonAttachmentBrokerPath(projectRoot);
  const temporary = `${pathname}.${process.pid}.${expected.instanceId}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(expected, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  if (process.platform !== 'win32') await fs.chmod(temporary, 0o600);
  try {
    await fs.rename(temporary, pathname);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function readGovernanceDaemonAttachmentBroker(
  projectRoot: string,
): Promise<GovernanceDaemonAttachmentBrokerReadResult> {
  const raw = await readBounded(governanceDaemonAttachmentBrokerPath(projectRoot));
  return raw === null ? { kind: 'missing' } : parseAttachmentBroker(raw, projectRoot);
}

export async function removeOwnedGovernanceDaemonAttachmentBroker(
  projectRoot: string,
  owner: Pick<GovernanceDaemonMetadata, 'pid' | 'instanceId'>,
): Promise<boolean> {
  const pathname = governanceDaemonAttachmentBrokerPath(projectRoot);
  const raw = await readBounded(pathname);
  if (raw === null) return false;
  const parsed = parseAttachmentBroker(raw, projectRoot);
  if (
    parsed.kind !== 'valid' ||
    parsed.broker.pid !== owner.pid ||
    parsed.broker.instanceId !== owner.instanceId
  ) {
    return false;
  }
  return removeIfUnchanged(pathname, raw);
}

export function createGovernanceDaemonMetadata(options: {
  readonly projectRoot: string;
  readonly projectId: string;
  readonly pid: number;
  readonly instanceId: string;
  readonly startedAt: string;
}): GovernanceDaemonMetadata {
  const metadata: GovernanceDaemonMetadata = {
    schemaVersion: GOVERNANCE_DAEMON_METADATA_SCHEMA_VERSION,
    protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
    projectKey: governanceProjectKey(options.projectRoot),
    projectRoot: canonicalGovernanceProjectRoot(options.projectRoot),
    projectId: options.projectId,
    endpoint: governanceProjectServerEndpoint(options.projectRoot),
    pid: options.pid,
    instanceId: options.instanceId,
    startedAt: options.startedAt,
  };
  const validated = parseMetadata(JSON.stringify(metadata), options.projectRoot);
  if (validated.kind !== 'valid') {
    throw new Error(
      validated.kind === 'invalid' ? validated.reason : 'Governance daemon metadata is missing.',
    );
  }
  return validated.metadata;
}

export async function writeGovernanceDaemonMetadata(
  projectRoot: string,
  metadata: GovernanceDaemonMetadata,
): Promise<void> {
  const expected = createGovernanceDaemonMetadata(metadata);
  await ensurePrivateDirectory(projectRoot);
  const pathname = governanceDaemonMetadataPath(projectRoot);
  const temporary = `${pathname}.${process.pid}.${expected.instanceId}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(expected, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  try {
    await fs.rename(temporary, pathname);
  } catch {
    await fs.rm(pathname, { force: true });
    await fs.rename(temporary, pathname);
  }
  if (process.platform !== 'win32') await fs.chmod(pathname, 0o600);
}

export async function readGovernanceDaemonMetadata(
  projectRoot: string,
): Promise<GovernanceDaemonMetadataReadResult> {
  const raw = await readBounded(governanceDaemonMetadataPath(projectRoot));
  return raw === null ? { kind: 'missing' } : parseMetadata(raw, projectRoot);
}

export async function removeOwnedGovernanceDaemonMetadata(
  projectRoot: string,
  owner: Pick<GovernanceDaemonMetadata, 'pid' | 'instanceId'>,
): Promise<boolean> {
  const pathname = governanceDaemonMetadataPath(projectRoot);
  const raw = await readBounded(pathname);
  if (raw === null) return false;
  const parsed = parseMetadata(raw, projectRoot);
  if (
    parsed.kind !== 'valid' ||
    parsed.metadata.pid !== owner.pid ||
    parsed.metadata.instanceId !== owner.instanceId
  ) {
    return false;
  }
  return removeIfUnchanged(pathname, raw);
}

function isGovernanceProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === 'EPERM';
  }
}

function probeGovernanceDaemonEndpoint(
  projectRoot: string,
  timeoutMs = GOVERNANCE_DAEMON_ENDPOINT_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new Error('Governance endpoint probe timeout must be positive.'));
  }
  return new Promise((resolve) => {
    const socket = net.createConnection(governanceProjectServerEndpoint(projectRoot));
    let settled = false;
    const finish = (reachable: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(reachable);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

export async function inspectGovernanceDaemon(
  projectRoot: string,
): Promise<GovernanceDaemonInspection> {
  const [metadataResult, endpointReachable] = await Promise.all([
    readGovernanceDaemonMetadata(projectRoot),
    probeGovernanceDaemonEndpoint(projectRoot),
  ]);
  if (metadataResult.kind === 'valid') {
    const ownerAlive = isGovernanceProcessAlive(metadataResult.metadata.pid);
    if (ownerAlive && endpointReachable) return { kind: 'live', metadata: metadataResult.metadata };
    if (!ownerAlive && !endpointReachable) {
      return {
        kind: 'stale',
        metadata: metadataResult.metadata,
        metadataState: 'dead-owner',
      };
    }
    return {
      kind: 'endpoint_invalid',
      metadata: metadataResult.metadata,
      reason: ownerAlive
        ? 'Metadata owner is alive but its endpoint is unreachable.'
        : 'Endpoint is reachable but metadata owner is not alive.',
    };
  }
  if (endpointReachable) {
    return {
      kind: 'endpoint_invalid',
      metadata: null,
      reason:
        metadataResult.kind === 'invalid'
          ? 'Endpoint is reachable but daemon metadata is invalid.'
          : 'Endpoint is reachable but daemon metadata is missing.',
    };
  }
  return {
    kind: 'stale',
    metadata: null,
    metadataState: metadataResult.kind === 'invalid' ? 'invalid' : 'missing',
  };
}

export function shouldRecoverGovernanceEndpoint(
  platform: NodeJS.Platform,
  inspection: GovernanceDaemonInspection,
): boolean {
  return platform !== 'win32' && inspection.kind === 'stale';
}

export class GovernanceDaemonStartupLease {
  readonly path: string;
  readonly record: GovernanceDaemonStartupLeaseRecord;
  private released = false;

  constructor(
    readonly projectRoot: string,
    pathname: string,
    record: GovernanceDaemonStartupLeaseRecord,
    private readonly raw: string,
  ) {
    this.path = pathname;
    this.record = record;
  }

  async release(): Promise<boolean> {
    if (this.released) return false;
    this.released = true;
    return removeIfUnchanged(this.path, this.raw);
  }
}

export async function acquireGovernanceDaemonStartupLease(
  options: AcquireGovernanceDaemonStartupLeaseOptions,
): Promise<GovernanceDaemonStartupLease> {
  const timeoutMs = options.timeoutMs ?? GOVERNANCE_DAEMON_STARTUP_LEASE_TIMEOUT_MS;
  const retryMs = options.retryMs ?? GOVERNANCE_DAEMON_STARTUP_LEASE_RETRY_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Governance startup lease timeout must be positive.');
  }
  if (!Number.isSafeInteger(retryMs) || retryMs <= 0) {
    throw new Error('Governance startup lease retry interval must be positive.');
  }
  const now = options.now ?? Date.now;
  const isAlive = options.isProcessAlive ?? isGovernanceProcessAlive;
  const directory = await ensurePrivateDirectory(options.projectRoot);
  const pathname = governanceDaemonStartupLeasePath(options.projectRoot);
  const record: GovernanceDaemonStartupLeaseRecord = Object.freeze({
    schemaVersion: GOVERNANCE_DAEMON_STARTUP_LEASE_SCHEMA_VERSION,
    projectKey: governanceProjectKey(options.projectRoot),
    pid: options.pid,
    instanceId: options.instanceId,
    startedAt: options.startedAt,
  });
  const raw = `${JSON.stringify(record)}\n`;
  if (!parseLease(raw, options.projectRoot)) {
    throw new Error('Governance startup lease identity is invalid.');
  }
  const deadline = now() + timeoutMs;
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });

  while (true) {
    try {
      const handle = await fs.open(pathname, 'wx', 0o600);
      try {
        await handle.writeFile(raw, 'utf8');
      } finally {
        await handle.close();
      }
      return new GovernanceDaemonStartupLease(options.projectRoot, pathname, record, raw);
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
    }

    const existingRaw = await readBounded(pathname);
    if (existingRaw === null) continue;
    const existing = parseLease(existingRaw, options.projectRoot);
    if (!existing) {
      throw new GovernanceDaemonStartupLeaseError(
        'invalid_lease',
        'Governance daemon startup lease is invalid and was not removed automatically.',
      );
    }
    if (!isAlive(existing.pid)) {
      await removeIfUnchanged(pathname, existingRaw);
      continue;
    }
    if (now() >= deadline) {
      throw new GovernanceDaemonStartupLeaseError(
        'busy',
        `Governance daemon startup lease is held by live process ${existing.pid}.`,
      );
    }
    await delay(Math.min(retryMs, Math.max(1, deadline - now())));
  }
}
