import { writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';

const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
let activePromptId: number | undefined;
const inbox = createInterface({ input: process.stdin });
inbox.on('line', (line) => {
  void (async () => {
    const message = JSON.parse(line);
    if (message.method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: {},
          authMethods: [],
          _meta: { steering: { supported: true } },
        },
      });
    } else if (message.method === 'session/new') {
      send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'adr-transport' } });
    } else if (message.method === 'session/prompt') {
      activePromptId = message.id;
      await writeFile(process.env.ADR_WIRE_INITIAL!, JSON.stringify(message.params));
    } else if (message.method === '_session/steering') {
      await writeFile(process.env.ADR_WIRE_REFRESH!, JSON.stringify(message.params));
      send({ jsonrpc: '2.0', id: message.id, result: { outcome: 'injected' } });
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'adr-transport',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Reviewed architecture context received.' },
          },
        },
      });
      send({ jsonrpc: '2.0', id: activePromptId, result: { stopReason: 'end_turn' } });
    } else if (message.id !== undefined) {
      send({ jsonrpc: '2.0', id: message.id, result: {} });
    }
  })().catch((error) => {
    process.stderr.write(String(error));
    process.exitCode = 1;
    inbox.close();
  });
});
