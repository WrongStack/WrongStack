import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { hostname } from 'node:os';
import { basename } from 'node:path';
import type { HqClientConfig } from '../types/config.js';
import type { Logger } from '../types/logger.js';
import { readProjectIdentitySync } from '../utils/project-identity.js';
import {
  type HqAuthFile,
  hqAuthFilePath,
  readHqRuntimeFileSync,
  resolveHqDataDir,
} from './auth-store.js';
import type {
  HqClientCapability,
  HqClientIdentity,
  HqProjectIdentity,
  HqRedactionPolicy,
} from './protocol.js';
import {
  HqPublisher,
  type HqPublisherCommandHandler,
  type HqPublisherOptions,
  type HqSocketFactory,
} from './publisher.js';

export interface HqPublisherEnvConfig {
  url: string;
  token?: string;
  enabled?: boolean;
  rawContent?: boolean;
  projectAlias?: string;
  /**
   * Same-machine auto-discovery mode: no explicit URL was configured, so the
   * publisher should re-resolve the endpoint from `<dataDir>/runtime.json`
   * (+ the first client token in `auth.json`) before every connect attempt.
   * This lets every client on the machine attach to a `wstack --hq` that is
   * already running, starts later, or restarts on a different port.
   */
  discover?: boolean;
  /** Resolved HQ data dir the discovery reads from. */
  dataDir?: string;
}

/**
 * Discover a locally running `wstack --hq` endpoint: reads the runtime
 * marker (pid-liveness-checked) and the first client token. Returns
 * `undefined` when no live HQ is advertised on this machine.
 */
export function discoverLocalHqEndpoint(
  options: { dataDir?: string | undefined; env?: NodeJS.ProcessEnv | undefined } = {},
): { url: string; token?: string | undefined } | undefined {
  const dataDir = resolveHqDataDir(options.dataDir, options.env ?? process.env);
  const runtime = readHqRuntimeFileSync(dataDir);
  if (runtime === undefined) return undefined;
  // WS-037: `isLoopbackHqUrl` already guards the explicit-config path for this
  // exact reason — the local client token is only valid for a same-machine
  // server. Discovery skipped it, so anyone able to write runtime.json could
  // redirect the whole telemetry stream, and the local token with it, to a
  // remote host.
  if (!isLoopbackHqUrl(runtime.url)) return undefined;
  const token = readFirstClientTokenFromAuthFile(dataDir);
  return { url: runtime.url, ...(token ? { token } : {}) };
}

function readFirstClientTokenFromAuthFile(dataDir: string): string | undefined {
  try {
    const raw = fs.readFileSync(hqAuthFilePath(dataDir), 'utf8');
    const parsed = JSON.parse(raw) as HqAuthFile;
    return parsed.clientTokens?.find((t) => t.token.trim().length > 0)?.token;
  } catch {
    return undefined;
  }
}

/**
 * True when an explicit HQ URL targets this machine. Falling back to the
 * LOCAL auth.json client token is only valid for same-machine servers — a
 * remote HQ has its own auth.json, and sending the local token would put the
 * publisher into a silent 401 reconnect loop.
 */
function isLoopbackHqUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (
      host === '127.0.0.1' ||
      host === 'localhost' ||
      host === '::1' ||
      host === '[::1]' ||
      host === '0.0.0.0'
    );
  } catch {
    return false;
  }
}

export function resolveHqConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): HqPublisherEnvConfig | undefined {
  return resolveHqConfig({ env });
}

export function resolveHqConfig(
  options: { env?: NodeJS.ProcessEnv | undefined; config?: HqClientConfig | undefined } = {},
): HqPublisherEnvConfig | undefined {
  const env = options.env ?? process.env;
  const fileConfig = options.config;
  const envUrl = env['WRONGSTACK_HQ_URL']?.trim();
  const envToken = env['WRONGSTACK_HQ_TOKEN']?.trim();
  const configUrl = fileConfig?.url?.trim();
  const configToken = fileConfig?.token?.trim();
  const envEnabledRaw = env['WRONGSTACK_HQ_ENABLED']?.trim();
  const enabled =
    envEnabledRaw !== undefined && envEnabledRaw.length > 0
      ? envEnabledRaw !== '0'
      : fileConfig?.enabled;
  const dataDir = resolveHqDataDir(fileConfig?.dataDir, env);
  const explicitToken = envToken || configToken;
  const runtimeUrl = readHqRuntimeFileSync(dataDir)?.url.trim();
  const url = envUrl || configUrl;
  // The local auth.json client token is only a valid fallback for
  // same-machine endpoints (discovery, or an explicit loopback URL). For a
  // remote URL without an explicit token, send NO token — the server's 401
  // is then an honest signal instead of a guaranteed-wrong local token.
  const localFallbackToken =
    !url || isLoopbackHqUrl(url) ? readFirstClientTokenFromAuthFile(dataDir) : undefined;
  const token = explicitToken || localFallbackToken;

  const rawContentEnv = env['WRONGSTACK_HQ_RAW_CONTENT']?.trim();
  const explicitRawContent = rawContentEnv ? rawContentEnv === '1' : fileConfig?.rawContent;
  const projectAliasEnv = env['WRONGSTACK_HQ_PROJECT_ALIAS']?.trim();
  const projectAlias = projectAliasEnv || fileConfig?.projectAlias;

  if (!url) {
    if (enabled === false) return undefined;
    // No explicit endpoint → same-machine auto-discovery (default ON).
    // The publisher re-resolves runtime.json + auth.json before every
    // connect attempt, so an HQ started AFTER this client — or restarted on
    // another port — is attached to automatically. While no HQ is running
    // the publisher stays dormant (bounded queue, cheap file poll).
    // Opt out with WRONGSTACK_HQ_ENABLED=0 or config `hq.enabled: false`.
    //
    // Same-machine HQ defaults to RAW content: the data never leaves this
    // machine and the operator watching HQ is the same user running the
    // sessions — a redacted chat history there is useless. Opt out with
    // WRONGSTACK_HQ_RAW_CONTENT=0 or `hq.rawContent: false` (/hq raw off).
    // Secret scrubbing + sensitive-field masking still always apply.
    return {
      url: runtimeUrl || 'http://127.0.0.1:3499',
      enabled: true,
      discover: true,
      dataDir,
      rawContent: explicitRawContent ?? true,
      ...(token ? { token } : {}),
      ...(projectAlias ? { projectAlias } : {}),
    };
  }

  // Explicit URL: raw content is the default for every HQ target. Operators
  // can still opt out with WRONGSTACK_HQ_RAW_CONTENT=0 or hq.rawContent=false,
  // and the HQ server can clamp disclosure with auth.json redactionPolicy.
  const rawContent = explicitRawContent ?? true;
  return {
    url,
    ...(token ? { token } : {}),
    ...(enabled !== undefined ? { enabled } : {}),
    ...(rawContent !== undefined ? { rawContent } : {}),
    ...(projectAlias ? { projectAlias } : {}),
  };
}

function stableMachineId(): string {
  // Stable per *physical machine*, NOT per process — every terminal on the
  // same computer must share one machineId so HQ groups them under a single
  // machine node. (Process identity already lives in clientId via the pid.)
  return createHash('sha256').update(hostname()).digest('hex').slice(0, 12);
}

export function deriveHqProjectId(projectRoot: string, projectAlias?: string): string {
  const projectIdentity = readProjectIdentitySync(projectRoot);
  if (projectIdentity) return projectIdentity.projectId;
  const alias = projectAlias?.trim();
  if (!alias && projectRoot.startsWith('alias:')) {
    throw new Error('projectRoot must not use the reserved "alias:" HQ identity prefix');
  }
  const identity = alias ? `alias:${alias}` : projectRoot;
  return createHash('sha256').update(identity).digest('hex').slice(0, 12);
}

export interface CreateHqPublisherOptions {
  clientKind: HqClientIdentity['kind'];
  projectRoot: string;
  projectName?: string;
  machineId?: string;
  hostnameOverride?: string;
  socketFactory?: HqSocketFactory;
  config?: HqPublisherEnvConfig;
  appConfig?: { hq?: HqClientConfig | undefined } | undefined;
  redactionPolicy?: Partial<HqRedactionPolicy>;
  /** Forwarded to the HqPublisher constructor (Phase 4 control plane). */
  capabilities?: readonly HqClientCapability[];
  /** Bound offline telemetry retained by this client. */
  maxQueuedMessages?: number;
  /** Forwarded to the HqPublisher constructor (Phase 4 control plane). */
  onCommand?: HqPublisherCommandHandler;
  /** Receives the latest merged Kanban snapshot from HQ. */
  onKanbanSnapshot?: HqPublisherOptions['onKanbanSnapshot'];
  /** Dormant discovery re-check interval override (tests / tight loops). */
  discoveryPollMs?: number;
  /** Logger for structured connect-failure diagnostics. */
  logger?: Logger | undefined;
}

export function createHqPublisherFromEnv(
  options: CreateHqPublisherOptions,
): HqPublisher | undefined {
  const config = options.config ?? resolveHqConfig({ config: options.appConfig?.hq });
  if (!config || config.enabled === false) return undefined;

  const machineId = options.machineId ?? stableMachineId();
  const host = options.hostnameOverride ?? hostname();
  const projectAlias = config.projectAlias?.trim() || undefined;
  const projectName =
    projectAlias ?? options.projectName ?? (basename(options.projectRoot) || 'unknown');

  const client: HqClientIdentity = {
    clientId: `${machineId}:${options.clientKind}:${process.pid}:${randomUUID().slice(0, 8)}`,
    kind: options.clientKind,
    machineId,
    ...(host ? { hostname: host } : {}),
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };

  const project: HqProjectIdentity = {
    projectId: deriveHqProjectId(options.projectRoot, projectAlias),
    projectRoot: options.projectRoot,
    projectName,
    machineId,
    workspaceKind: 'git',
  };

  const redactionPolicy: Partial<HqRedactionPolicy> | undefined =
    options.redactionPolicy || config.rawContent !== undefined
      ? {
          ...(config.rawContent !== undefined ? { rawContent: config.rawContent } : {}),
          ...(options.redactionPolicy ?? {}),
        }
      : undefined;

  const discoveryDataDir = config.dataDir;
  return new HqPublisher({
    url: config.url,
    ...(config.token ? { token: config.token } : {}),
    client,
    project,
    ...(options.socketFactory ? { socketFactory: options.socketFactory } : {}),
    ...(redactionPolicy !== undefined ? { redactionPolicy } : {}),
    ...(options.capabilities !== undefined ? { capabilities: options.capabilities } : {}),
    ...(options.maxQueuedMessages !== undefined
      ? { maxQueuedMessages: options.maxQueuedMessages }
      : {}),
    ...(options.onCommand !== undefined ? { onCommand: options.onCommand } : {}),
    ...(options.onKanbanSnapshot !== undefined
      ? { onKanbanSnapshot: options.onKanbanSnapshot }
      : {}),
    // Auto-discovery: re-read the local HQ runtime marker + client token on
    // every connect attempt so late-started/restarted HQs are picked up.
    ...(config.discover
      ? { resolveEndpoint: () => discoverLocalHqEndpoint({ dataDir: discoveryDataDir }) }
      : {}),
    ...(options.discoveryPollMs !== undefined ? { discoveryPollMs: options.discoveryPollMs } : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
  });
}
