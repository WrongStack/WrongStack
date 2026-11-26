import type { Request } from '@wrongstack/contracts/types';
import { expect, it } from 'vitest';
import { REQUIRED_FIELD_LAST_RESORT_MAX_OUTPUT } from '../src/model-output-limits.js';
import { anthropicWireFormat } from '../src/presets/anthropic.js';
import { openaiWireFormat } from '../src/presets/openai.js';

const request: Request = {
  model: 'fixture-model',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
};

it('falls back to the model ceiling when the request limit rounds to zero', () => {
  const body = anthropicWireFormat.buildBody(
    { ...request, maxTokens: 0.5 },
    { capabilities: { ...anthropicWireFormat.capabilities, maxOutput: 512 } },
  );
  expect(body).toMatchObject({ max_tokens: 512 });
});

it('uses the required-field fallback when the capability limit rounds to zero', () => {
  const body = anthropicWireFormat.buildBody(request, {
    capabilities: { ...anthropicWireFormat.capabilities, maxOutput: 0.5 },
  });
  expect(body).toMatchObject({ max_tokens: REQUIRED_FIELD_LAST_RESORT_MAX_OUTPUT });
});

it('omits the optional field when the only cap rounds to zero', () => {
  const body = openaiWireFormat.buildBody(
    { ...request, maxTokens: 0.5 },
    { capabilities: openaiWireFormat.capabilities },
  );
  expect(body).toMatchObject({ model: request.model });
  expect(body).not.toHaveProperty('max_completion_tokens');
});

it('still sends one token for a valid limit that rounds down to one', () => {
  const body = anthropicWireFormat.buildBody(
    { ...request, maxTokens: 1.5 },
    { capabilities: { ...anthropicWireFormat.capabilities, maxOutput: 512 } },
  );
  expect(body).toMatchObject({ max_tokens: 1 });
});
