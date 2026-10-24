import type { Capabilities, Message, Request } from '@wrongstack/contracts/types';
import { describe, expect, it } from 'vitest';
import { convertMessages } from '../src/ai-gateway.js';
import { OpenAIResponsesProvider } from '../src/openai-responses.js';
import { anthropicWireFormat } from '../src/presets/anthropic.js';
import { googleWireFormat } from '../src/presets/google.js';
import { messagesToOpenAI } from '../src/tool-format/to-openai.js';
import { messagesToResponsesInput } from '../src/tool-format/to-responses.js';

const VALID_IMAGE_BASE64 = `/EAAA${'A'.repeat(24)}/AA`;
const CORRUPTED_IMAGE_BASE64 = 'AAAA[REDACTED:square_token]AAAA';
const convertGatewayMessages = convertMessages as unknown as (
  input: Message[],
  options?: { allowImages?: boolean },
) => ReturnType<typeof convertMessages>;

function messages(data = VALID_IMAGE_BASE64): Message[] {
  return [
    {
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
        { type: 'text', text: 'inspect this image' },
      ],
    },
  ];
}

function capabilities(base: Capabilities, vision: boolean): Capabilities {
  return { ...base, vision };
}

class InspectableResponsesProvider extends OpenAIResponsesProvider {
  body(request: Request): Record<string, unknown> {
    return this.buildBody(request, { capabilities: this.capabilities, providerId: this.id });
  }
}

describe('image input contracts across provider wires', () => {
  it('uses text markers instead of native media parts for text-only models', () => {
    const anthropic = anthropicWireFormat.buildBody(
      { model: 'text-only', maxTokens: 10, messages: messages() } as Request,
      {
        capabilities: capabilities(anthropicWireFormat.capabilities, false),
        providerId: 'anthropic',
      },
    ) as { messages: Array<{ content: Array<Record<string, unknown>> }> };
    expect(anthropic.messages[0]?.content).toEqual([
      { type: 'text', text: '[image omitted: model accepts text only]' },
      { type: 'text', text: 'inspect this image' },
    ]);

    const google = googleWireFormat.buildBody(
      { model: 'text-only', messages: messages() } as Request,
      {
        capabilities: capabilities(googleWireFormat.capabilities, false),
        providerId: 'google',
      },
    ) as { contents: Array<{ parts: Array<Record<string, unknown>> }> };
    expect(google.contents[0]?.parts).toEqual([
      { text: '[image omitted: model accepts text only]' },
      { text: 'inspect this image' },
    ]);

    const responses = messagesToResponsesInput(messages(), { allowImages: false });
    expect(responses[0]?.['content']).toEqual([
      { type: 'input_text', text: '[image omitted: model accepts text only]' },
      { type: 'input_text', text: 'inspect this image' },
    ]);

    const responsesProvider = new InspectableResponsesProvider({
      id: 'responses-text-only',
      apiKey: 'k',
      baseUrl: 'https://example.test/v1',
      capabilities: { vision: false },
    });
    const responsesBody = responsesProvider.body({
      model: 'text-only',
      messages: messages(),
    });
    expect((responsesBody['input'] as Array<Record<string, unknown>>)[0]?.['content']).toEqual([
      { type: 'input_text', text: '[image omitted: model accepts text only]' },
      { type: 'input_text', text: 'inspect this image' },
    ]);

    const chat = messagesToOpenAI(undefined, messages(), { allowImages: false });
    expect(chat[0]?.content).toBe('[image omitted: model accepts text only]inspect this image');

    const gateway = convertGatewayMessages(messages(), { allowImages: false }) as Array<{
      content: Array<Record<string, unknown>>;
    }>;
    expect(gateway[0]?.content).toEqual([
      { type: 'text', text: '[image omitted: model accepts text only]' },
      { type: 'text', text: 'inspect this image' },
    ]);
  });

  it('rejects corrupted historical base64 locally on every native image wire', () => {
    const anthropic = anthropicWireFormat.buildBody(
      { model: 'vision', maxTokens: 10, messages: messages(CORRUPTED_IMAGE_BASE64) } as Request,
      {
        capabilities: capabilities(anthropicWireFormat.capabilities, true),
        providerId: 'anthropic',
      },
    ) as { messages: Array<{ content: Array<Record<string, unknown>> }> };
    expect(anthropic.messages[0]?.content[0]).toEqual({
      type: 'text',
      text: '[image omitted: invalid base64 data; reattach image]',
    });

    const google = googleWireFormat.buildBody(
      { model: 'vision', messages: messages(CORRUPTED_IMAGE_BASE64) } as Request,
      {
        capabilities: capabilities(googleWireFormat.capabilities, true),
        providerId: 'google',
      },
    ) as { contents: Array<{ parts: Array<Record<string, unknown>> }> };
    expect(google.contents[0]?.parts[0]).toEqual({
      text: '[image omitted: invalid base64 data; reattach image]',
    });

    const responses = messagesToResponsesInput(messages(CORRUPTED_IMAGE_BASE64));
    const responseContent = responses[0]?.['content'] as Array<Record<string, unknown>> | undefined;
    expect(responseContent?.[0]).toEqual({
      type: 'input_text',
      text: '[image omitted: invalid base64 data; reattach image]',
    });

    const chat = messagesToOpenAI(undefined, messages(CORRUPTED_IMAGE_BASE64));
    expect(chat[0]?.content).toBe(
      '[image omitted: invalid base64 data; reattach image]inspect this image',
    );

    const gateway = convertGatewayMessages(messages(CORRUPTED_IMAGE_BASE64)) as Array<{
      content: Array<Record<string, unknown>>;
    }>;
    expect(gateway[0]?.content[0]).toEqual({
      type: 'text',
      text: '[image omitted: invalid base64 data; reattach image]',
    });
  });

  it('surfaces remote images instead of silently dropping them on the Gemini wire', () => {
    const remote: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'url', url: 'https://example.test/image.png' } },
        ],
      },
    ];
    const body = googleWireFormat.buildBody({ model: 'vision', messages: remote } as Request, {
      capabilities: capabilities(googleWireFormat.capabilities, true),
      providerId: 'google',
    }) as { contents: Array<{ parts: Array<Record<string, unknown>> }> };
    expect(body.contents[0]?.parts).toEqual([
      { text: '[image omitted: provider requires uploaded image data; reattach image]' },
    ]);
  });
});
