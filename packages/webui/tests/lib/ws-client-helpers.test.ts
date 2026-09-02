import { describe, expect, it } from 'vitest';
import {
  buildClearModelsMessage,
  buildProviderUpdateMessage,
  buildUndoClearMessage,
} from '../../src/lib/ws-client-helpers';

/**
 * Tests for the `provider.*` message payload builders. These
 * helpers are the single source of truth for the wire shape —
 * the `WSClient` methods (`undoProviderClear`, etc.) call them
 * directly, and the WS server's dispatch case matches on the
 * returned `type` field. Pinning the shape here means a
 * accidental rename in either direction is caught at unit-test
 * time, not at runtime.
 */

describe('buildClearModelsMessage', () => {
  it('builds a provider.clear_models message with the supplied providerId', () => {
    expect(buildClearModelsMessage('ollama')).toEqual({
      type: 'provider.clear_models',
      payload: { providerId: 'ollama' },
    });
  });

  it('preserves the id verbatim (no case folding, no trim)', () => {
    expect(buildClearModelsMessage('  OpenAI  ')).toEqual({
      type: 'provider.clear_models',
      payload: { providerId: '  OpenAI  ' },
    });
  });
});

describe('buildUndoClearMessage', () => {
  it('builds a provider.undo_clear message with the supplied providerId and previousModels', () => {
    expect(buildUndoClearMessage('ollama', ['llama3.1:8b', 'qwen2.5:7b'])).toEqual({
      type: 'provider.undo_clear',
      payload: {
        providerId: 'ollama',
        previousModels: ['llama3.1:8b', 'qwen2.5:7b'],
      },
    });
  });

  it("preserves the order of the input list (caller's order is the source of truth)", () => {
    const msg = buildUndoClearMessage('a', ['z', 'y', 'x']);
    expect(msg).toEqual({
      type: 'provider.undo_clear',
      payload: { providerId: 'a', previousModels: ['z', 'y', 'x'] },
    });
  });

  it('accepts an empty list (caller pre-checked `shouldFireUndoToast`)', () => {
    expect(buildUndoClearMessage('a', [])).toEqual({
      type: 'provider.undo_clear',
      payload: { providerId: 'a', previousModels: [] },
    });
  });

  it('defensive-copies the input list (caller mutation does not leak)', () => {
    const input = ['x', 'y'];
    const msg = buildUndoClearMessage('a', input);
    input.push('z');
    expect(msg.payload).toMatchObject({ previousModels: ['x', 'y'] });
  });

  it('does not mutate the input list', () => {
    const input = ['x', 'y'];
    buildUndoClearMessage('a', input);
    expect(input).toEqual(['x', 'y']);
  });
});

describe('buildProviderUpdateMessage', () => {
  it('passes through the full payload (including all optional fields)', () => {
    const payload = {
      id: 'ollama',
      family: 'openai-compatible',
      baseUrl: 'http://localhost:11434/v1',
      envVars: ['OLLAMA_HOST'],
      models: ['llama3.1:8b'],
    };
    expect(buildProviderUpdateMessage(payload)).toEqual({
      type: 'provider.update',
      payload,
    });
  });

  it('accepts a minimal payload (just the id)', () => {
    expect(buildProviderUpdateMessage({ id: 'ollama' })).toEqual({
      type: 'provider.update',
      payload: { id: 'ollama' },
    });
  });
});

describe('message-type discrimination', () => {
  it('clear_models and undo_clear have distinct type discriminators', () => {
    const clear = buildClearModelsMessage('a');
    const undo = buildUndoClearMessage('a', ['x']);
    expect(clear.type).not.toBe(undo.type);
  });

  it('all three builders produce a message with a non-empty type field', () => {
    const messages = [
      buildClearModelsMessage('a'),
      buildUndoClearMessage('a', ['x']),
      buildProviderUpdateMessage({ id: 'a' }),
    ];
    for (const m of messages) {
      expect(m.type).toBeTruthy();
      expect(typeof m.type).toBe('string');
    }
  });
});
