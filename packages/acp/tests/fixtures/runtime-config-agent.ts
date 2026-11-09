import { createInterface } from 'node:readline';

let model = 'fast';
let effort = 'low';
const options = () => [
  {
    id: 'engine',
    category: 'model',
    type: 'select',
    name: 'Model',
    currentValue: model,
    options: ['fast', 'deep'].map((value) => ({ value, name: value })),
  },
  {
    id: 'thought',
    category: 'thought_level',
    type: 'select',
    name: 'Effort',
    currentValue: effort,
    options: (model === 'fast' ? ['low', 'medium'] : ['high', 'ultra']).map((value) => ({
      value,
      name: value,
    })),
  },
  {
    id: 'mode',
    type: 'select',
    name: 'Permissions',
    currentValue: 'ask',
    options: [
      { value: 'ask', name: 'Ask' },
      { value: 'all', name: 'Allow all' },
    ],
  },
];
for await (const line of createInterface({ input: process.stdin })) {
  const msg = JSON.parse(line);
  let result: unknown = {};
  if (msg.method === 'initialize')
    result = { protocolVersion: 1, agentCapabilities: {}, authMethods: [] };
  if (msg.method === 'session/new') result = { sessionId: 'fixture', configOptions: options() };
  if (msg.method === 'session/set_config_option') {
    if (msg.params.configId === 'engine') {
      model = msg.params.value;
      effort = model === 'fast' ? 'low' : 'high';
    }
    if (msg.params.configId === 'thought' && process.env.ACP_IGNORE_SETTING !== '1')
      effort = msg.params.value;
    if (process.env.ACP_NOTIFY_ONLY === '1') {
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'fixture', update: { sessionUpdate: 'config_option_update', configOptions: options() } } })}\n`,
      );
      result = {};
    } else result = { configOptions: options() };
  }
  if (msg.method === 'session/prompt') {
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'fixture', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `${model}/${effort}` } } } })}\n`,
    );
    result = { stopReason: 'end_turn' };
  }
  if (msg.id !== undefined)
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n`);
}
