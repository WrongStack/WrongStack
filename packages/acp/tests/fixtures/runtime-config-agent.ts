import { createInterface } from 'node:readline';

let model = 'fast';
let effort = process.env.ACP_UNLISTED_DEFAULT === '1' ? 'default' : 'low';
let thinking = false;
const modernAndLegacy = process.env.ACP_MODERN_AND_LEGACY_MODELS === '1';
const modelConfigId = modernAndLegacy ? 'model' : 'engine';
const models = () => ({
  currentModelId: model,
  availableModels: [
    { modelId: 'fast', name: 'Fast' },
    { modelId: 'deep', name: 'Deep' },
  ],
});
const options = () => [
  {
    id: modelConfigId,
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
  ...(process.env.ACP_BOOLEAN_SETTING === '1'
    ? [
        {
          id: 'thinking',
          category: 'model_config',
          type: 'boolean',
          name: 'Thinking',
          currentValue: thinking,
        },
      ]
    : []),
];
for await (const line of createInterface({ input: process.stdin })) {
  const msg = JSON.parse(line);
  let result: unknown = {};
  if (msg.method === 'initialize')
    result = { protocolVersion: 1, agentCapabilities: {}, authMethods: [] };
  if (msg.method === 'session/new') {
    result =
      process.env.ACP_LEGACY_MODELS === '1'
        ? {
            sessionId: 'fixture',
            models: models(),
          }
        : {
            sessionId: 'fixture',
            configOptions: options(),
            ...(modernAndLegacy ? { models: models() } : {}),
          };
  }
  if (msg.method === 'session/set_model') {
    if (modernAndLegacy) {
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found: session/set_model' } })}\n`,
      );
      continue;
    }
    model = msg.params.modelId;
    result = {};
  }
  if (msg.method === 'session/set_config_option') {
    if (msg.params.configId === 'thinking') {
      if (msg.params.type !== 'boolean' || typeof msg.params.value !== 'boolean') {
        process.stdout.write(
          `${JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'Expected a boolean setting' } })}\n`,
        );
        continue;
      }
      thinking = msg.params.value;
    }
    if (msg.params.configId === modelConfigId) {
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
    if (
      msg.params.prompt.some((block: { text?: string }) =>
        block.text?.endsWith('Adjust your effort'),
      )
    ) {
      effort = 'medium';
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'fixture', update: { sessionUpdate: 'config_option_update', configOptions: options() } } })}\n`,
      );
    }
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'fixture', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `${model}/${effort}` } } } })}\n`,
    );
    result = { stopReason: 'end_turn' };
  }
  if (msg.id !== undefined)
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n`);
}
