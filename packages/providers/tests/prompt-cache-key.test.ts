import type { Capabilities, Request } from '@wrongstack/core/types';
import { describe, expect, it } from 'vitest';
import { applyPromptCacheKey } from '../src/prompt-cache-key.js';
import { openaiWireFormat } from '../src/presets/openai.js';
import { anthropicWireFormat } from '../src/presets/anthropic.js';
import { googleWireFormat } from '../src/presets/google.js';

const caps = (cacheControl: 'native' | 'auto' | 'none'): Capabilities =>
  ({ cacheControl, promptCache: cacheControl !== 'none', maxOutput: 4096 }) as Capabilities;

const baseReq = (cache?: Request['cache']): Request =>
  ({ model: 'm', maxTokens: 256, messages: [], cache }) as Request;

describe('applyPromptCacheKey helper', () => {
  it('sets prompt_cache_key on auto-cache providers when a key is present', () => {
    const body: Record<string, unknown> = {};
    applyPromptCacheKey(body, baseReq({ key: 'ws-abc' }), caps('auto'));
    expect(body['prompt_cache_key']).toBe('ws-abc');
  });

  it('skips native (Anthropic) and none (Google) providers', () => {
    const native: Record<string, unknown> = {};
    applyPromptCacheKey(native, baseReq({ key: 'ws-abc' }), caps('native'));
    expect(native).not.toHaveProperty('prompt_cache_key');
    const none: Record<string, unknown> = {};
    applyPromptCacheKey(none, baseReq({ key: 'ws-abc' }), caps('none'));
    expect(none).not.toHaveProperty('prompt_cache_key');
  });

  it('is a no-op when no key or no caps', () => {
    const noKey: Record<string, unknown> = {};
    applyPromptCacheKey(noKey, baseReq({ ttl: '5m' }), caps('auto'));
    expect(noKey).not.toHaveProperty('prompt_cache_key');
    const noCaps: Record<string, unknown> = {};
    applyPromptCacheKey(noCaps, baseReq({ key: 'ws-abc' }), undefined);
    expect(noCaps).not.toHaveProperty('prompt_cache_key');
  });
});

describe('OpenAI preset buildBody — prompt_cache_key', () => {
  it('emits prompt_cache_key when the key is set and caps are auto', () => {
    const body = openaiWireFormat.buildBody(
      { ...baseReq({ key: 'ws-deadbeef' }) },
      { capabilities: caps('auto') },
    );
    expect(body['prompt_cache_key']).toBe('ws-deadbeef');
  });

  it('omits prompt_cache_key when no key is present', () => {
    const body = openaiWireFormat.buildBody({ ...baseReq() }, { capabilities: caps('auto') });
    expect(body).not.toHaveProperty('prompt_cache_key');
  });

  it('does not throw when called without a ctx (one-arg test convention)', () => {
    const body = openaiWireFormat.buildBody({ ...baseReq({ key: 'ws-x' }) } as Parameters<
      typeof openaiWireFormat.buildBody
    >[0]);
    expect(body).not.toHaveProperty('prompt_cache_key'); // no caps → skipped
  });
});

describe('Anthropic preset buildBody — ignores prompt_cache_key', () => {
  it('never sets prompt_cache_key even when req.cache.key is present', () => {
    const body = anthropicWireFormat.buildBody(
      {
        model: 'm',
        maxTokens: 8,
        messages: [],
        system: [{ type: 'text', text: 'x' }],
        cache: { key: 'ws-x' },
      } as Parameters<typeof anthropicWireFormat.buildBody>[0],
      { capabilities: caps('native') },
    );
    expect(body).not.toHaveProperty('prompt_cache_key');
  });
});

describe('Google preset buildBody — ignores prompt_cache_key', () => {
  it('never sets prompt_cache_key (Gemini uses cachedContent, not a routing key)', () => {
    const body = googleWireFormat.buildBody(
      { model: 'm', maxTokens: 8, messages: [], cache: { key: 'ws-x' } } as Parameters<
        typeof googleWireFormat.buildBody
      >[0],
      { capabilities: caps('none') },
    );
    expect(body).not.toHaveProperty('prompt_cache_key');
  });

  // P3a — implicit caching needs a byte-stable systemInstruction prefix.
  it('produces a deterministic systemInstruction for the same system prompt', () => {
    const req = {
      model: 'gemini-2.5-pro',
      maxTokens: 8,
      messages: [],
      system: [
        { type: 'text', text: 'stable identity' },
        { type: 'text', text: 'tools' },
      ],
    } as Parameters<typeof googleWireFormat.buildBody>[0];
    const a = googleWireFormat.buildBody({ ...req }, { capabilities: caps('none') });
    const b = googleWireFormat.buildBody({ ...req }, { capabilities: caps('none') });
    expect(a['systemInstruction']).toEqual(b['systemInstruction']);
    expect(JSON.stringify(a['systemInstruction'])).toBe(JSON.stringify(b['systemInstruction']));
  });
});
