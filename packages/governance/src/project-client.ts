import * as net from 'node:net';

import type { GovernanceServiceCredential } from './capability-grant.js';
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

export class GovernanceProjectClient {
  readonly endpoint: string;

  private readonly credential: GovernanceServiceCredential;
  private readonly timeoutMs: number;

  constructor(
    projectRoot: string,
    credential: GovernanceServiceCredential,
    options: GovernanceProjectClientOptions = {},
  ) {
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
      let buffer = Buffer.alloc(0);
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
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.byteLength > GOVERNANCE_IPC_MAX_FRAME_BYTES) {
          finish(new Error('Governance IPC response exceeded the frame limit.'));
          return;
        }
        const newline = buffer.indexOf(0x0a);
        if (newline < 0) return;
        try {
          const parsed = JSON.parse(buffer.subarray(0, newline).toString('utf8')) as unknown;
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
