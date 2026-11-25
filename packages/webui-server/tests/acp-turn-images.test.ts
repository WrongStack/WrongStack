import { expect, it, vi } from 'vitest';
import { buildTurnInput } from '../src/server/conversation-turn-input.js';

const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWioAAAAASUVORK5CYII=';

it('preserves a WebUI image when the current ACP session advertises native image input', async () => {
  const supportsVisionFor = vi.fn(async () => true);
  const agent = {
    ctx: {
      provider: { id: 'acp', capabilities: { vision: false }, supportsVisionFor },
      model: 'codex-cli',
      session: { id: 'active-conversation' },
    },
    tools: { list: () => [] },
  };
  const input = await buildTurnInput(
    agent as never,
    { content: 'Inspect this image', images: [{ data: png, mediaType: 'image/png' }] },
    new AbortController().signal,
  );
  expect(supportsVisionFor).toHaveBeenCalledWith('codex-cli', 'active-conversation');
  expect(input).toContainEqual({
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: png },
  });
});

it('uses the existing image fallback when the live ACP agent declines visual input', async () => {
  const agent = {
    ctx: {
      provider: { id: 'acp', capabilities: { vision: true }, supportsVisionFor: async () => false },
      model: 'text-agent',
      session: { id: 'active-conversation' },
    },
    tools: { list: () => [] },
  };
  await expect(
    buildTurnInput(
      agent as never,
      { content: 'Inspect this image', images: [{ data: png }] },
      new AbortController().signal,
    ),
  ).rejects.toThrow('does not support image input');
});
