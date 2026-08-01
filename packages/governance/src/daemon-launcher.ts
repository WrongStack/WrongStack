import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { GovernanceServiceCredential } from './capability-grant.js';
import { readGovernanceDaemonMetadata } from './daemon-metadata.js';
import {
  decodeGovernanceDaemonBootstrapMessage,
  decodeGovernanceDaemonBootstrapRequest,
  GOVERNANCE_DAEMON_BOOTSTRAP_PROTOCOL_VERSION,
} from './daemon-protocol.js';
import { canonicalGovernanceProjectRoot } from './ipc-endpoint.js';
import type { GovernanceServiceCapability } from './service-protocol.js';

export const GOVERNANCE_DAEMON_STARTUP_TIMEOUT_MS = 10_000;

export type GovernanceDaemonAvailability =
  | { readonly kind: 'available'; readonly entrypoint: URL }
  | { readonly kind: 'missing-build' };

export type GovernanceDaemonLaunchErrorCode =
  | 'missing_build'
  | 'spawn_failed'
  | 'startup_timeout'
  | 'startup_busy'
  | 'startup_failed'
  | 'owner_conflict'
  | 'endpoint_invalid'
  | 'invalid_handshake'
  | 'process_exited';

export class GovernanceDaemonLaunchError extends Error {
  constructor(
    readonly code: GovernanceDaemonLaunchErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'GovernanceDaemonLaunchError';
  }
}

export interface LaunchGovernanceProjectDaemonOptions {
  readonly projectRoot: string;
  readonly projectId: string;
  readonly clientId: string;
  readonly capabilities: readonly GovernanceServiceCapability[];
  readonly ttlMs: number;
  readonly timeoutMs?: number | undefined;
}

export interface GovernanceProjectDaemonLaunch {
  readonly pid: number;
  readonly projectRoot: string;
  readonly projectId: string;
  readonly instanceId: string;
  readonly startedAt: string;
  readonly grantId: string;
  readonly expiresAt: string;
  readonly credential: GovernanceServiceCredential;
}

interface GovernanceDaemonRuntime {
  readonly entrypoint: URL;
  readonly execArgv?: readonly string[] | undefined;
  readonly cwd?: string | undefined;
  readonly detached?: boolean | undefined;
  readonly environment?: NodeJS.ProcessEnv | undefined;
}

const SAFE_ENVIRONMENT_KEYS = new Set([
  'LANG',
  'LC_ALL',
  'PATH',
  'PATHEXT',
  'Path',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'TZ',
  'WINDIR',
]);

export function governanceDaemonEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(source).filter(
      ([key, value]) => SAFE_ENVIRONMENT_KEYS.has(key) && value !== undefined,
    ),
  );
}

export function resolveGovernanceDaemonAvailability(
  moduleUrl = import.meta.url,
  exists: (filePath: string) => boolean = fs.existsSync,
): GovernanceDaemonAvailability {
  try {
    const entrypoint = new URL('./project-daemon.js', moduleUrl);
    if (entrypoint.protocol === 'file:' && exists(fileURLToPath(entrypoint))) {
      return { kind: 'available', entrypoint };
    }
  } catch {
    // Report the stable missing-build result below.
  }
  return { kind: 'missing-build' };
}

function validateLaunchOptions(options: LaunchGovernanceProjectDaemonOptions): void {
  if (options.projectId.trim().length === 0 || options.projectId.length > 512) {
    throw new GovernanceDaemonLaunchError(
      'invalid_handshake',
      'Governance daemon projectId must be a non-empty string of at most 512 characters.',
    );
  }
  if (options.clientId.trim().length === 0 || options.clientId.length > 512) {
    throw new GovernanceDaemonLaunchError(
      'invalid_handshake',
      'Governance daemon clientId must be a non-empty string of at most 512 characters.',
    );
  }
  if (!Number.isSafeInteger(options.ttlMs) || options.ttlMs <= 0) {
    throw new GovernanceDaemonLaunchError(
      'invalid_handshake',
      'Governance daemon grant ttlMs must be a positive safe integer.',
    );
  }
  const timeoutMs = options.timeoutMs ?? GOVERNANCE_DAEMON_STARTUP_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new GovernanceDaemonLaunchError(
      'invalid_handshake',
      'Governance daemon timeout must be a positive safe integer.',
    );
  }
}

export function launchGovernanceProjectDaemon(
  options: LaunchGovernanceProjectDaemonOptions,
): Promise<GovernanceProjectDaemonLaunch> {
  const availability = resolveGovernanceDaemonAvailability();
  if (availability.kind !== 'available') {
    return Promise.reject(
      new GovernanceDaemonLaunchError(
        'missing_build',
        'Built governance project daemon is unavailable; refusing an implicit in-process fallback.',
      ),
    );
  }
  return launchGovernanceProjectDaemonWithRuntime(options, {
    entrypoint: availability.entrypoint,
  });
}

/** Internal seam for source-level process tests; public callers use the built entrypoint above. */
export function launchGovernanceProjectDaemonWithRuntime(
  options: LaunchGovernanceProjectDaemonOptions,
  runtime: GovernanceDaemonRuntime,
): Promise<GovernanceProjectDaemonLaunch> {
  validateLaunchOptions(options);
  const projectRoot = path.resolve(options.projectRoot);
  const canonicalRoot = canonicalGovernanceProjectRoot(projectRoot);
  const timeoutMs = options.timeoutMs ?? GOVERNANCE_DAEMON_STARTUP_TIMEOUT_MS;
  const nonce = randomBytes(32).toString('base64url');
  const decodedRequest = decodeGovernanceDaemonBootstrapRequest({
    type: 'bootstrap',
    protocolVersion: GOVERNANCE_DAEMON_BOOTSTRAP_PROTOCOL_VERSION,
    nonce,
    clientId: options.clientId,
    capabilities: options.capabilities,
    ttlMs: options.ttlMs,
  });
  if (!decodedRequest.decoded) {
    return Promise.reject(
      new GovernanceDaemonLaunchError(
        'invalid_handshake',
        `Governance daemon bootstrap options are invalid: ${decodedRequest.issues[0]?.message ?? 'unknown issue'}`,
      ),
    );
  }
  const bootstrapRequest = decodedRequest.request;
  let child: ChildProcess;
  try {
    child = spawn(
      process.execPath,
      [
        ...(runtime.execArgv ?? []),
        fileURLToPath(runtime.entrypoint),
        '--project-root',
        projectRoot,
        '--project-id',
        options.projectId,
      ],
      {
        cwd: runtime.cwd ?? projectRoot,
        detached: runtime.detached ?? true,
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        env: runtime.environment ?? governanceDaemonEnvironment(process.env),
        serialization: 'json',
      },
    );
  } catch (error) {
    return Promise.reject(
      new GovernanceDaemonLaunchError(
        'spawn_failed',
        `Governance daemon could not be spawned: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let readyReceived = false;
    let readyInstanceId: string | undefined;
    let readyStartedAt: string | undefined;
    const pid = child.pid;

    const releaseChild = (): void => {
      try {
        if (child.connected) child.disconnect();
      } catch {
        // The child may have closed its side of the one-shot bootstrap channel first.
      }
      child.unref();
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('error', onError);
      child.off('exit', onExit);
    };
    const fail = (error: GovernanceDaemonLaunchError, terminate = true): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (terminate && child.exitCode === null && child.signalCode === null) child.kill();
      releaseChild();
      reject(error);
    };
    const succeed = (result: GovernanceProjectDaemonLaunch): void => {
      if (settled) return;
      settled = true;
      cleanup();
      releaseChild();
      resolve(Object.freeze(result));
    };
    const invalidHandshake = (message: string): void => {
      fail(new GovernanceDaemonLaunchError('invalid_handshake', message));
    };
    const sendBootstrap = (): void => {
      try {
        child.send(bootstrapRequest, (error) => {
          if (error) {
            fail(
              new GovernanceDaemonLaunchError(
                'startup_failed',
                `Governance daemon bootstrap request failed: ${error.message}`,
              ),
            );
          }
        });
      } catch (error) {
        fail(
          new GovernanceDaemonLaunchError(
            'startup_failed',
            `Governance daemon bootstrap request failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
    };
    const onMessage = (input: unknown): void => {
      const decoded = decodeGovernanceDaemonBootstrapMessage(input);
      if (!decoded.decoded) {
        invalidHandshake(
          `Governance daemon returned an invalid handshake: ${decoded.issues[0]?.message ?? 'unknown issue'}`,
        );
        return;
      }
      const message = decoded.message;
      if (message.type === 'bootstrap_error') {
        const code: GovernanceDaemonLaunchErrorCode =
          message.code === 'owner_conflict'
            ? 'owner_conflict'
            : message.code === 'startup_busy'
              ? 'startup_busy'
              : message.code === 'endpoint_invalid'
                ? 'endpoint_invalid'
                : 'startup_failed';
        fail(new GovernanceDaemonLaunchError(code, message.message), false);
        return;
      }
      if (!pid || message.pid !== pid) {
        invalidHandshake('Governance daemon handshake PID does not match the spawned process.');
        return;
      }
      if (
        canonicalGovernanceProjectRoot(message.projectRoot) !== canonicalRoot ||
        message.projectId !== options.projectId
      ) {
        invalidHandshake('Governance daemon handshake project identity does not match.');
        return;
      }
      if (message.type === 'ready') {
        if (readyReceived) {
          invalidHandshake('Governance daemon sent duplicate ready messages.');
          return;
        }
        readyReceived = true;
        readyInstanceId = message.instanceId;
        readyStartedAt = message.startedAt;
        sendBootstrap();
        return;
      }
      if (!readyReceived) {
        invalidHandshake('Governance daemon returned credentials before declaring readiness.');
        return;
      }
      if (
        message.nonce !== nonce ||
        message.instanceId !== readyInstanceId ||
        message.startedAt !== readyStartedAt ||
        message.credential.projectId !== options.projectId ||
        message.credential.clientId !== options.clientId
      ) {
        invalidHandshake('Governance daemon bootstrap credential identity does not match.');
        return;
      }
      if (!Number.isFinite(Date.parse(message.expiresAt))) {
        invalidHandshake('Governance daemon bootstrap credential has an invalid expiry.');
        return;
      }
      void readGovernanceDaemonMetadata(projectRoot)
        .then((metadataResult) => {
          if (
            metadataResult.kind !== 'valid' ||
            metadataResult.metadata.pid !== message.pid ||
            metadataResult.metadata.instanceId !== message.instanceId ||
            metadataResult.metadata.startedAt !== message.startedAt ||
            metadataResult.metadata.projectId !== options.projectId
          ) {
            invalidHandshake('Governance daemon metadata does not match the bootstrap identity.');
            return;
          }
          succeed({
            pid: message.pid,
            projectRoot,
            projectId: options.projectId,
            instanceId: message.instanceId,
            startedAt: message.startedAt,
            grantId: message.grantId,
            expiresAt: message.expiresAt,
            credential: message.credential,
          });
        })
        .catch(() => invalidHandshake('Governance daemon metadata could not be verified.'));
    };
    const onError = (error: Error): void => {
      fail(
        new GovernanceDaemonLaunchError(
          'spawn_failed',
          `Governance daemon process failed: ${error.message}`,
        ),
      );
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      fail(
        new GovernanceDaemonLaunchError(
          'process_exited',
          `Governance daemon exited before bootstrap completed (code=${String(code)}, signal=${String(signal)}).`,
        ),
        false,
      );
    };
    const timer = setTimeout(() => {
      fail(
        new GovernanceDaemonLaunchError(
          'startup_timeout',
          `Governance daemon bootstrap exceeded ${timeoutMs}ms.`,
        ),
      );
    }, timeoutMs);

    child.on('message', onMessage);
    child.once('error', onError);
    child.once('exit', onExit);
  });
}
