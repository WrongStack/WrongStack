/**
 * `POST /api/command` with `type: "approve"` — the capability gate.
 *
 * Approving a tool call from HQ is a stronger act than steering one: `always`
 * and `deny` write persistent policy onto the remote machine, and `yes` can
 * release a destructive call. So it rides its OWN capability rather than the
 * general `control.enqueue`, and an operator can hand out a steer-only
 * credential that cannot answer prompts.
 *
 * The target check matters too: an `approve` queued against a client that does
 * not mirror approvals would sit at "delivered" while the prompt on the
 * machine quietly times out.
 */
import type * as http from 'node:http';
import { Readable } from 'node:stream';
import { type HqCommandAuditLog, hqTokenVerifier } from '@wrongstack/core/hq';
import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { handleApiCommand } from '../src/hq-server/routes/command-handlers.js';
import type {
  ConnectedClient,
  HqRouterMutableAuth,
  HqSessionEntry,
} from '../src/hq-server/types.js';

const BROWSER_TOKEN = 'browser-token-value';
// The live set holds verifiers, not secrets — the header carries the secret.
const BROWSER_VERIFIER = hqTokenVerifier(BROWSER_TOKEN);

function makeAuth(capabilities: string[]): HqRouterMutableAuth {
  return {
    operatorPolicy: { rawContent: true, toolArgs: 'full', paths: 'full' },
    operatorPolicyOverride: undefined,
    browserTokens: new Set([BROWSER_VERIFIER]),
    clientTokens: new Set<string>(),
    browserTokenObjs: new Map([[BROWSER_VERIFIER, { id: 'tok-1', capabilities }]]),
    clientTokenObjs: new Map(),
    alertRules: undefined,
  } as unknown as HqRouterMutableAuth;
}

function makeClient(capabilities: string[]): ConnectedClient {
  return {
    ws: {} as WebSocket,
    clientId: 'client-1',
    projectId: 'proj-1',
    project: { projectId: 'proj-1', projectName: 'proj', machineId: 'm1' },
    kind: 'tui',
    connectedAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    capabilities,
    declaredRedactionPolicy: { rawContent: true, toolArgs: 'full', paths: 'full' },
    lastEventSeq: 0,
    mailboxes: new Map(),
    sessions: new Map(),
    fleets: new Map(),
    mcpSnapshots: new Map(),
    commandQueue: [],
    isLeader: true,
  } as unknown as ConnectedClient;
}

function makeRequest(body: unknown): http.IncomingMessage {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as http.IncomingMessage;
  (req as { headers: http.IncomingHttpHeaders }).headers = {
    authorization: `Bearer ${BROWSER_TOKEN}`,
  };
  return req;
}

function makeResponse(): {
  res: http.ServerResponse;
  status: () => number | undefined;
  body: () => string;
} {
  let status: number | undefined;
  let body = '';
  const res = {
    writeHead: (code: number) => {
      status = code;
      return res;
    },
    end: (chunk?: string) => {
      if (chunk) body += chunk;
    },
  } as unknown as http.ServerResponse;
  return { res, status: () => status, body: () => body };
}

async function post(input: {
  browserCapabilities: string[];
  clientCapabilities: string[];
  payload?: Record<string, unknown>;
}): Promise<{ status: number | undefined; body: string; queued: number }> {
  const client = makeClient(input.clientCapabilities);
  const clients = new Map<WebSocket, ConnectedClient>([[client.ws, client]]);
  const { res, status, body } = makeResponse();
  await handleApiCommand(
    makeRequest({
      clientId: 'client-1',
      type: 'approve',
      payload: input.payload ?? { toolUseId: 'toolu_1', decision: 'yes' },
    }),
    res,
    new URL('http://hq.local/api/command'),
    makeAuth(input.browserCapabilities),
    new Map<string, HqSessionEntry>(),
    clients,
    new Set<WebSocket>(),
    { record: vi.fn(), update: vi.fn(), get: vi.fn() } as unknown as HqCommandAuditLog,
    { evaluate: vi.fn().mockResolvedValue({ kind: 'allow', reason: 'ok' }) } as never,
  );
  return { status: status(), body: body(), queued: client.commandQueue.length };
}

describe('POST /api/command type=approve', () => {
  it('refuses a credential that can steer but was never granted approval', async () => {
    const result = await post({
      browserCapabilities: ['control.enqueue'],
      clientCapabilities: ['control.receive', 'control.approve'],
    });
    expect(result.status).toBe(403);
    expect(result.body).toContain('control.approve');
    expect(result.queued).toBe(0);
  });

  it('refuses a client that does not mirror approvals', async () => {
    const result = await post({
      browserCapabilities: ['control.enqueue', 'control.approve'],
      clientCapabilities: ['control.receive'],
    });
    expect(result.status).toBe(409);
    expect(result.queued).toBe(0);
  });

  it('queues the command when both sides carry the capability', async () => {
    const result = await post({
      browserCapabilities: ['control.enqueue', 'control.approve'],
      clientCapabilities: ['control.receive', 'control.approve'],
    });
    expect(result.status).toBe(202);
    expect(result.queued).toBe(1);
  });

  it('refuses a decision outside the closed set before it is ever queued', async () => {
    const result = await post({
      browserCapabilities: ['control.enqueue', 'control.approve'],
      clientCapabilities: ['control.receive', 'control.approve'],
      payload: { toolUseId: 'toolu_1', decision: 'abort' },
    });
    expect(result.status).toBe(400);
    expect(result.queued).toBe(0);
  });
});
