// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';
import {
  isLikelyNonChatModel,
  pushRecentModel,
  readRecentModels,
  searchModelRows,
  visibleModelGroups,
} from '../src/lib/model-catalog-view.js';
import type { ModelDescriptor } from '../src/types.js';

function model(id: string, name?: string, contextWindow = 200_000): ModelDescriptor {
  return { id, name: name ?? id, contextWindow };
}

beforeEach(() => {
  localStorage.clear();
});

describe('isLikelyNonChatModel', () => {
  it('flags embeddings, rerankers, voice and media pipelines', () => {
    for (const id of [
      'text-embedding-ada-002',
      'text-embedding-3-large',
      'bge-m3',
      'nv-embed-v1',
      'rerank-qa-mistral-4b',
      'whisper-large-v3',
      'nemotron-voicechat',
      'studiovoice',
      'riva-translate-4b-instruct-v1_1',
      'active-speaker-detection',
      'gliner-pii',
      'usdvalidate',
      'esmfold',
      'cosmos-transfer2.5-2b',
      'sparsedrive',
    ]) {
      expect(isLikelyNonChatModel(model(id)), id).toBe(true);
    }
  });

  it('flags image and video generators by id and display name', () => {
    for (const [id, name] of [
      ['gpt-image-1.5', 'gpt-image-1.5'],
      ['wan2.7-image', 'Wan2.7 Image'],
      ['qwen-image-2.0', 'Qwen Image 2.0'],
      ['happyhorse-1.1-i2v', 'HappyHorse 1.1 I2V'],
      ['flux.1-dev', 'FLUX.1-dev'],
      ['chatgpt-image-latest', 'chatgpt-image-latest'],
    ] as const) {
      expect(isLikelyNonChatModel(model(id, name)), id).toBe(true);
    }
  });

  it('keeps chat models including vision-capable and image-tuned chat models', () => {
    for (const [id, name] of [
      ['gpt-4o', 'GPT-4o'],
      ['gemini-2.5-flash-image', 'Nano Banana (Gemini 2.5 Flash Image)'],
      ['claude-opus-4.8', 'Claude Opus 4.8'],
      ['kimi-k3', 'Kimi K3'],
      ['usdcode', 'usdcode'],
    ] as const) {
      expect(isLikelyNonChatModel(model(id, name)), id).toBe(false);
    }
    // llama-guard IS a safety guard and should be filtered
    expect(isLikelyNonChatModel(model('llama-guard-4-12b', 'Llama Guard 4 12B'))).toBe(true);
  });
});

describe('visibleModelGroups', () => {
  it('drops empty providers, duplicate ids and non-chat models', () => {
    const groups = visibleModelGroups({
      openai: [
        model('gpt-4o', 'GPT-4o'),
        model('gpt-4o', 'GPT-4o duplicate'),
        model('text-embedding-3-small', 'text-embedding-3-small'),
      ],
      empty: [],
      anthropic: [model('claude-opus-4.8', 'Claude Opus 4.8')],
    });
    expect(groups.map(([p]) => p)).toEqual(['openai', 'anthropic']);
    expect(groups[0]?.[1].map((entry) => entry.id)).toEqual(['gpt-4o']);
  });

  it('drops a provider whose every model is non-chat', () => {
    const groups = visibleModelGroups({
      retrieval: [model('bge-m3'), model('rerank-qa-mistral-4b')],
      openai: [model('gpt-5.4', 'GPT-5.4')],
    });
    expect(groups.map(([p]) => p)).toEqual(['openai']);
  });
});

describe('searchModelRows', () => {
  const groups: [string, ReturnType<typeof model>[]][] = [
    ['openai', [model('gpt-4o', 'GPT-4o'), model('gpt-5.4', 'GPT-5.4')]],
    ['anthropic', [model('claude-opus-4.8', 'Claude Opus 4.8')]],
  ];

  it('returns every row for an empty query with provider labels', () => {
    const rows = searchModelRows(groups, { openai: 'OpenAI' }, '');
    expect(rows).toHaveLength(3);
    expect(rows[0]?.providerLabel).toBe('OpenAI');
  });

  it('matches name, id and provider label case-insensitively', () => {
    expect(searchModelRows(groups, {}, 'opus').map((r) => r.entry.id)).toEqual(['claude-opus-4.8']);
    expect(
      searchModelRows(groups, { anthropic: 'Anthropic' }, 'anthropic').map((r) => r.entry.id),
    ).toEqual(['claude-opus-4.8']);
    expect(searchModelRows(groups, {}, 'GPT-5').map((r) => r.entry.id)).toEqual(['gpt-5.4']);
  });
});

describe('recent models persistence', () => {
  it('records picks most-recent-first, de-duplicates and caps at 5', () => {
    for (let i = 0; i < 7; i++) pushRecentModel('openai', `model-${i}`);
    pushRecentModel('openai', 'model-3');
    const recents = readRecentModels();
    expect(recents).toHaveLength(5);
    expect(recents[0]).toBe('openai\tmodel-3');
    expect(recents).not.toContain('openai\tmodel-0');
  });

  it('returns [] when nothing is stored', () => {
    expect(readRecentModels()).toEqual([]);
  });
});
