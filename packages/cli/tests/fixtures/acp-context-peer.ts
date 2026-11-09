import { writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';

const capture = process.env.ACP_CONTEXT_CAPTURE;
if (!capture) throw new Error('ACP_CONTEXT_CAPTURE is required');
const send = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line) as { id?: number | string; method?: string; params?: unknown };
  if (request.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: request.id,
      result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] },
    });
  } else if (request.method === 'session/new') {
    await writeFile(
      capture,
      JSON.stringify({ pid: process.pid, spawnCwd: process.cwd(), params: request.params }),
    );
    send({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'context-peer' } });
  } else if (request.method === 'session/prompt') {
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'context-peer',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'ACP_CONTEXT_PEER_OK' },
        },
      },
    });
    send({ jsonrpc: '2.0', id: request.id, result: { stopReason: 'end_turn' } });
  } else if (request.id !== undefined) {
    send({ jsonrpc: '2.0', id: request.id, result: {} });
  }
}
