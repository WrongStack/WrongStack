import { randomUUID } from 'node:crypto';
import * as net from 'node:net';
import * as path from 'node:path';

import type { GovernanceServiceCredential } from './capability-grant.js';
import { type GovernanceDaemonMetadata, inspectGovernanceDaemon } from './daemon-metadata.js';
import { governanceProjectServerEndpoint } from './ipc-endpoint.js';
import {
  decodeGovernanceIpcResponse,
  encodeGovernanceIpcFrame,
  GOVERNANCE_IPC_MAX_FRAME_BYTES,
  type GovernanceIpcRequestEnvelope,
} from './ipc-protocol.js';
import type { GovernanceServiceResponse } from './project-service.js';
import { GOVERNANCE_SERVICE_PROTOCOL_VERSION } from './service-protocol.js';

export const GOVERNANCE_IPC_DEFAULT_TIMEOUT_MS = 5_000;

export interface GovernanceProjectClientOptions {
  readonly timeoutMs?: number | undefined;
}

interface ConnectGovernanceProjectClientOptions extends GovernanceProjectClientOptions {
  readonly projectRoot: string;
  readonly projectId: string;
  readonly credential: GovernanceServiceCredential;
}

export type ConnectGovernanceProjectClientResult =
  | {
      readonly connected: true;
      readonly client: GovernanceProjectClient;
      readonly metadata: GovernanceDaemonMetadata;
    }
  | {
      readonly connected: false;
      readonly code:
        | 'not_running'
        | 'endpoint_invalid'
        | 'project_mismatch'
        | 'credential_mismatch'
        | 'authentication_failed'
        | 'service_rejected';
      readonly message: string;
    };

export class GovernanceProjectClient {
  readonly projectRoot: string;
  readonly endpoint: string;

  private readonly credential: GovernanceServiceCredential;
  private readonly timeoutMs: number;

  constructor(
    projectRoot: string,
    credential: GovernanceServiceCredential,
    options: GovernanceProjectClientOptions = {},
  ) {
    this.projectRoot = path.resolve(projectRoot);
    this.endpoint = governanceProjectServerEndpoint(projectRoot);
    this.credential = Object.freeze({ ...credential });
    this.timeoutMs = options.timeoutMs ?? GOVERNANCE_IPC_DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error('Governance IPC timeout must be a positive safe integer.');
    }
  }

  request(request: unknown): Promise<GovernanceServiceResponse> {
    const envelope: GovernanceIpcRequestEnvelope = {
      protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
      credential: this.credential,
      request,
    };
    const frame = encodeGovernanceIpcFrame(envelope);
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.endpoint);
      let settled = false;
      // Same framing rule as the server: hold the chunks and join once at the
      // delimiter, so a large response is not re-copied on every `data` event.
      const chunks: Buffer[] = [];
      let size = 0;
      const finish = (error?: Error, response?: GovernanceServiceResponse): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(error);
        else resolve(response!);
      };
      const timer = setTimeout(() => {
        finish(new Error(`Governance IPC request timed out after ${this.timeoutMs}ms.`));
      }, this.timeoutMs);
      socket.once('connect', () => socket.write(frame));
      socket.on('data', (chunk: Buffer) => {
        if (settled) return;
        const newline = chunk.indexOf(0x0a);
        const frameBytes = size + (newline < 0 ? chunk.byteLength : newline);
        if (frameBytes > GOVERNANCE_IPC_MAX_FRAME_BYTES) {
          finish(new Error('Governance IPC response exceeded the frame limit.'));
          return;
        }
        if (newline < 0) {
          chunks.push(chunk);
          size = frameBytes;
          return;
        }
        chunks.push(chunk.subarray(0, newline));
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
          const response = decodeGovernanceIpcResponse(parsed);
          const expectedRequestId =
            request &&
            typeof request === 'object' &&
            'requestId' in request &&
            typeof request.requestId === 'string'
              ? request.requestId
              : null;
          if (expectedRequestId && response.requestId !== expectedRequestId) {
            finish(new Error('Governance IPC response request id does not match.'));
            return;
          }
          finish(undefined, response);
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      });
      socket.once('error', (error) => finish(error));
      socket.once('end', () => {
        if (!settled) finish(new Error('Governance IPC connection ended without a response.'));
      });
    });
  }
}

export async function connectGovernanceProjectClient(
  options: ConnectGovernanceProjectClientOptions,
): Promise<ConnectGovernanceProjectClientResult> {
  if (options.credential.projectId !== options.projectId) {
    return {
      connected: false,
      code: 'credential_mismatch',
      message: 'Governance credential project identity does not match the requested project.',
    };
  }
  let inspection: Awaited<ReturnType<typeof inspectGovernanceDaemon>>;
  try {
    inspection = await inspectGovernanceDaemon(options.projectRoot);
  } catch {
    return {
      connected: false,
      code: 'endpoint_invalid',
      message: 'Governance daemon metadata or endpoint could not be inspected safely.',
    };
  }
  if (inspection.kind === 'stale') {
    if (inspection.metadataState === 'invalid') {
      return {
        connected: false,
        code: 'endpoint_invalid',
        message: 'Governance daemon metadata is invalid.',
      };
    }
    return {
      connected: false,
      code: 'not_running',
      message: `Governance daemon is not running (${inspection.metadataState}).`,
    };
  }
  if (inspection.kind === 'endpoint_invalid') {
    return { connected: false, code: 'endpoint_invalid', message: inspection.reason };
  }
  if (inspection.metadata.projectId !== options.projectId) {
    return {
      connected: false,
      code: 'project_mismatch',
      message: 'Governance daemon metadata belongs to another project identity.',
    };
  }
  const client = new GovernanceProjectClient(options.projectRoot, options.credential, {
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  try {
    const response = await client.request({
      protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
      requestId: `connect-${randomUUID()}`,
      type: 'health',
    });
    if (!response.ok) {
      return {
        connected: false,
        code:
          response.error.code === 'authentication_failed'
            ? 'authentication_failed'
            : 'service_rejected',
        message: response.error.message,
      };
    }
    if (
      response.result.type !== 'health' ||
      response.result.status !== 'ready' ||
      response.result.projectId !== options.projectId ||
      response.result.protocolVersion !== GOVERNANCE_SERVICE_PROTOCOL_VERSION
    ) {
      return {
        connected: false,
        code: 'endpoint_invalid',
        message: 'Governance health response does not match the discovered daemon identity.',
      };
    }
    return { connected: true, client, metadata: inspection.metadata };
  } catch (error) {
    return {
      connected: false,
      code: 'not_running',
      message: `Governance daemon connection failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
