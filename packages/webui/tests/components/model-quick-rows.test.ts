import { describe, expect, it } from 'vitest';
import { quickRows } from '@/components/ChatInput/model-quick-rows';

const now = 1_800_000_000;
const candidate = (provider: string, model: string, isFavorite = false) => ({
  provider,
  model,
  label: model,
  isFavorite,
});

describe('quickRows', () => {
  const candidates = [
    candidate('openai', 'gpt-5'),
    candidate('anthropic', 'claude-sonnet-4-5'),
    candidate('anthropic', 'claude-opus-4-1', true),
    candidate('zai', 'glm-4.6', true),
    candidate('acp', 'claude-code'),
    candidate('acp', 'codex-acp'),
  ];
  const quota = [
    {
      providerId: 'anthropic',
      meterId: 'plan',
      windows: [{ id: 'week', label: 'Week', usedPercent: 47, resetsAt: now + 60 }],
      capturedAt: now,
    },
  ];

  it('leads with the session provider, then favourites, then by name; agents after', () => {
    const rows = quickRows({
      candidates,
      session: { provider: 'openai', model: 'gpt-5' },
      quota,
    });
    expect(rows.map((row) => row.key)).toEqual([
      'openai',
      'anthropic',
      'zai',
      'acp/claude-code',
      'acp/codex-acp',
    ]);
    expect(rows[0]).toMatchObject({ current: true, model: 'gpt-5', name: 'OpenAI' });
    expect(rows[1]).toMatchObject({ status: { kind: 'quota', left: 53, window: 'Week' } });
    // A provider's favourite models come first under it.
    expect(rows[1]!.models.map((model) => model.model)).toEqual([
      'claude-opus-4-1',
      'claude-sonnet-4-5',
    ]);
    expect(rows.slice(3).map((row) => [row.name, row.agent])).toEqual([
      ['Claude Code', true],
      ['Codex', true],
    ]);
  });

  it('puts agents first for an ACP session and keeps its agent when it is not listed', () => {
    const rows = quickRows({
      candidates,
      session: { provider: 'acp', model: 'gemini-cli' },
      quota: [],
    });
    expect(rows.slice(0, 3).map((row) => row.key)).toEqual([
      'acp/gemini-cli',
      'acp/claude-code',
      'acp/codex-acp',
    ]);
    expect(rows[0]).toMatchObject({ current: true, name: 'Gemini CLI' });
  });

  it('keeps the session provider before its models have loaded', () => {
    const rows = quickRows({
      candidates: [],
      session: { provider: 'ollama', model: 'qwen3' },
      quota: [],
    });
    expect(rows).toEqual([
      expect.objectContaining({ key: 'ollama', current: true, model: 'qwen3', models: [] }),
    ]);
  });
});
