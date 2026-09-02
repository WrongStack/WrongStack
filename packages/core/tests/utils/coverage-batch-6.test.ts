import { describe, it, expect } from 'vitest';
import { repairToolUseAdjacency } from '../../src/utils/message-invariants.js';
import {
  parseIncomingImages,
  buildUserContentBlocks,
  IncomingImageError,
  MAX_INCOMING_IMAGES,
} from '../../src/utils/incoming-images.js';
import { mergeCustomModelDefs } from '../../src/utils/merge-custom-models.js';
import { mergeModelsPayload } from '../../src/utils/merge-models-payload.js';
import type { ContentBlock } from '../../src/types/blocks.js';
import type { Message } from '../../src/types/messages.js';

// ── message-invariants ──────────────────────────────────────────────────

describe('repairToolUseAdjacency', () => {
  function asst(...blocks: ContentBlock[]): Message {
    return { role: 'assistant', content: blocks };
  }
  function user(...blocks: ContentBlock[]): Message {
    return { role: 'user', content: blocks };
  }
  function tu(id: string): ContentBlock {
    return { type: 'tool_use', id, name: 'tool', input: {} };
  }
  function tr(id: string): ContentBlock {
    return { type: 'tool_result', tool_use_id: id, content: 'ok' };
  }
  function text(t: string): ContentBlock {
    return { type: 'text', text: t };
  }

  it('passes through clean paired sequences unchanged', () => {
    const msgs = [asst(text('hi'), tu('a')), user(tr('a'))];
    const result = repairToolUseAdjacency(msgs);
    expect(result.report.changed).toBe(false);
    expect(result.messages).toBe(msgs);
  });

  it('removes orphaned tool_use when next message lacks matching result', () => {
    const msgs = [asst(text('ok'), tu('a')), user(text('no result'))];
    const result = repairToolUseAdjacency(msgs);
    expect(result.report.changed).toBe(true);
    expect(result.report.removedToolUses).toEqual(['a']);
    // assistant message still has text
    expect(result.messages[0]?.content).toEqual([text('ok')]);
  });

  it('removes orphaned tool_result when no preceding tool_use', () => {
    const msgs = [asst(text('hello')), user(tr('orphan'))];
    const result = repairToolUseAdjacency(msgs);
    expect(result.report.changed).toBe(true);
    expect(result.report.removedToolResults).toEqual(['orphan']);
  });

  it('removes entirely empty messages after block removal', () => {
    const msgs = [asst(tu('a')), user(text('nothing'))];
    const result = repairToolUseAdjacency(msgs);
    expect(result.report.removedMessages).toBeGreaterThanOrEqual(0);
    // The assistant message with only a removed tool_use becomes empty → removed
    expect(result.messages.length).toBeLessThan(msgs.length);
  });

  it('handles string-content messages without crashing', () => {
    const msgs: Message[] = [{ role: 'user', content: 'hello' }];
    const result = repairToolUseAdjacency(msgs);
    expect(result.report.changed).toBe(false);
  });

  it('handles empty message array', () => {
    const result = repairToolUseAdjacency([]);
    expect(result.report.changed).toBe(false);
    expect(result.messages).toEqual([]);
  });
});

// ── incoming-images ─────────────────────────────────────────────────────

describe('parseIncomingImages', () => {
  it('returns empty array for no images', () => {
    expect(parseIncomingImages()).toEqual([]);
    expect(parseIncomingImages([])).toEqual([]);
  });

  it('parses a valid base64 image with media type', () => {
    const result = parseIncomingImages([{ data: 'iVBORw0KGgo=', mediaType: 'image/png' }]);
    expect(result).toHaveLength(1);
    expect(result[0]?.type).toBe('image');
    expect(result[0]?.source.type).toBe('base64');
    expect(result[0]?.source.media_type).toBe('image/png');
  });

  it('strips data: URL prefix and extracts media type', () => {
    const result = parseIncomingImages([{ data: 'data:image/jpeg;base64,/9j/4AAQ=' }]);
    expect(result).toHaveLength(1);
    expect(result[0]?.source.media_type).toBe('image/jpeg');
    expect(result[0]?.source.data).toBe('/9j/4AAQ=');
  });

  it('defaults media type to image/png when not specified', () => {
    const result = parseIncomingImages([{ data: 'iVBORw0KGgo=' }]);
    expect(result[0]?.source.media_type).toBe('image/png');
  });

  it('accepts legacy imageBase64', () => {
    const result = parseIncomingImages(undefined, 'data:image/png;base64,iVBOR');
    expect(result).toHaveLength(1);
  });

  it('throws on too many images', () => {
    const images = Array.from({ length: MAX_INCOMING_IMAGES + 1 }, () => ({ data: 'aGVsbG8=' }));
    expect(() => parseIncomingImages(images)).toThrow(IncomingImageError);
    expect(() => parseIncomingImages(images)).toThrow(/Too many images/);
  });

  it('throws on unsupported media type', () => {
    expect(() => parseIncomingImages([{ data: 'aGVsbG8=', mediaType: 'image/bmp' }])).toThrow(
      /unsupported media type/,
    );
  });

  it('throws on empty image data', () => {
    expect(() => parseIncomingImages([{ data: '' }])).toThrow(/empty image data/);
  });

  it('throws on invalid base64', () => {
    expect(() => parseIncomingImages([{ data: 'not!base64!!!' }])).toThrow(/not valid base64/);
  });

  it('throws on oversized image', () => {
    const huge = 'A'.repeat(12 * 1024 * 1024 * (4 / 3));
    expect(() => parseIncomingImages([{ data: huge }])).toThrow(/exceeds/);
  });
});

describe('buildUserContentBlocks', () => {
  it('places images before text', () => {
    const img = {
      type: 'image' as const,
      source: { type: 'base64' as const, media_type: 'image/png', data: 'abc' },
    };
    const blocks = buildUserContentBlocks('hello', [img]);
    expect(blocks[0]?.type).toBe('image');
    expect(blocks[1]?.type).toBe('text');
  });

  it('omits text block when text is empty', () => {
    const blocks = buildUserContentBlocks('', []);
    expect(blocks).toEqual([]);
  });
});

// ── merge-custom-models ─────────────────────────────────────────────────

describe('mergeCustomModelDefs', () => {
  it('returns undefined when both inputs are undefined', () => {
    expect(mergeCustomModelDefs(undefined, undefined)).toBeUndefined();
  });

  it('returns provider models when config models is undefined', () => {
    const result = mergeCustomModelDefs({ 'model-a': { name: 'A' } }, undefined);
    expect(result).toEqual({ 'model-a': { name: 'A' } });
  });

  it('config models override provider models on collision', () => {
    const result = mergeCustomModelDefs(
      { 'model-a': { name: 'Provider A' } },
      { 'model-a': { name: 'Config A' } },
    );
    expect(result?.['model-a']?.name).toBe('Config A');
  });

  it('merges non-overlapping models from both sources', () => {
    const result = mergeCustomModelDefs({ 'p-model': { name: 'P' } }, { 'c-model': { name: 'C' } });
    expect(Object.keys(result ?? {}).sort()).toEqual(['c-model', 'p-model']);
  });

  it('does not mutate inputs', () => {
    const provider = { m: { name: 'P' } };
    const config = { m: { name: 'C' } };
    mergeCustomModelDefs(provider, config);
    expect(provider['m']?.name).toBe('P');
    expect(config['m']?.name).toBe('C');
  });
});

// ── merge-models-payload ────────────────────────────────────────────────

describe('mergeModelsPayload', () => {
  it('clones base providers', () => {
    const base = {
      openai: { id: 'openai', name: 'OpenAI', models: { 'gpt-4': { id: 'gpt-4', name: 'GPT-4' } } },
    };
    const overlay = {};
    const result = mergeModelsPayload(base, overlay);
    expect(result.openai?.name).toBe('OpenAI');
    expect(result.openai).not.toBe(base.openai);
  });

  it('adds overlay-only providers', () => {
    const base = {};
    const overlay = {
      anthropic: {
        id: 'anthropic',
        name: 'Anthropic',
        models: { claude: { id: 'claude', name: 'Claude' } },
      },
    };
    const result = mergeModelsPayload(base, overlay);
    expect(result.anthropic?.name).toBe('Anthropic');
  });

  it('overlay scalar fields override base', () => {
    const base = { p: { id: 'p', name: 'Base', models: {} } };
    const overlay = { p: { id: 'p', name: 'Overlay', models: {} } };
    const result = mergeModelsPayload(base, overlay);
    expect(result.p?.name).toBe('Overlay');
  });

  it('overlay undefined scalars do not clobber base', () => {
    const base = { p: { id: 'p', name: 'Base', models: {} } };
    const overlay = { p: { id: 'p', models: {} } } as never;
    const result = mergeModelsPayload(base, overlay);
    expect(result.p?.name).toBe('Base');
  });

  it('merges model maps by id', () => {
    const base = { p: { id: 'p', name: 'P', models: { m1: { id: 'm1', name: 'M1' } } } };
    const overlay = { p: { id: 'p', name: 'Overlay', models: { m2: { id: 'm2', name: 'M2' } } } };
    const result = mergeModelsPayload(base, overlay);
    expect(Object.keys(result.p?.models ?? {}).sort()).toEqual(['m1', 'm2']);
  });

  it('deep-merges model limit/cost/modalities', () => {
    const base = {
      p: {
        id: 'p',
        name: 'P',
        models: {
          m: { id: 'm', name: 'M', limit: { context: 8000, output: 4096 }, cost: { input: 0.01 } },
        },
      },
    };
    const overlay = {
      p: {
        id: 'p',
        name: 'Overlay',
        models: {
          m: { id: 'm', name: 'M', limit: { context: 128000 }, cost: { output: 0.03 } },
        },
      },
    };
    const result = mergeModelsPayload(base, overlay);
    const model = result.p?.models?.['m'];
    expect(model?.limit).toEqual({ context: 128000, output: 4096 });
    expect(model?.cost).toEqual({ input: 0.01, output: 0.03 });
  });

  it('does not mutate inputs', () => {
    const base = {
      p: { id: 'p', name: 'Base', models: { m: { id: 'm', name: 'M', limit: { context: 100 } } } },
    };
    const overlay = {
      p: {
        id: 'p',
        name: 'Overlay',
        models: { m: { id: 'm', name: 'M', limit: { context: 200 } } },
      },
    };
    mergeModelsPayload(base, overlay);
    expect(base.p?.models?.['m']?.limit?.context).toBe(100);
  });
});
