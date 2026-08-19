import type { Request } from '@wrongstack/core/types';
import { describe, expect, it } from 'vitest';
import { applyOpenAICompatiblePolicy } from '../src/openai-compatible-policy.js';

function request(model: string, extra: Partial<Request> = {}): Request {
  return { model, messages: [{ role: 'user', content: 'hi' }], maxTokens: 10_000, ...extra };
}

describe('OpenAI-compatible provider policy', () => {
  it('uses OpenRouter unified reasoning even with function tools', () => {
    const body: Record<string, unknown> = { reasoning_effort: 'high', tool_choice: 'required' };
    applyOpenAICompatiblePolicy(
      body,
      request('anthropic/claude-sonnet-5', {
        reasoning: { effort: 'xhigh', display: 'summarized' },
        tools: [{ name: 'read', description: 'Read', inputSchema: {} }],
      }),
      'openrouter',
    );
    expect(body).not.toHaveProperty('reasoning_effort');
    expect(body['reasoning']).toEqual({ effort: 'xhigh', exclude: false });
  });

  it('keeps only DeepSeek high/max effort and normalizes forced tools', () => {
    const body: Record<string, unknown> = {
      reasoning_effort: 'medium',
      temperature: 0.5,
      top_p: 0.8,
      tool_choice: 'required',
    };
    const req = request('deepseek-v4-pro', {
      reasoning: { enabled: true, effort: 'max' },
      tools: [{ name: 'read', description: 'Read', inputSchema: {} }],
      toolChoice: 'required',
    });
    applyOpenAICompatiblePolicy(body, req, 'deepseek');
    expect(body).toMatchObject({
      thinking: { type: 'enabled' },
      reasoning_effort: 'max',
      tool_choice: 'auto',
    });
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('top_p');
  });

  it('implements Kimi per-model thinking contracts', () => {
    const k3: Record<string, unknown> = { reasoning_effort: 'high' };
    applyOpenAICompatiblePolicy(
      k3,
      request('kimi-k3', { reasoning: { effort: 'max' } }),
      'moonshotai',
    );
    expect(k3).toEqual({ reasoning_effort: 'max' });

    const k27: Record<string, unknown> = {
      reasoning_effort: 'high',
      thinking: { type: 'disabled' },
    };
    applyOpenAICompatiblePolicy(
      k27,
      request('kimi-k2.7-code', { reasoning: { enabled: false } }),
      'moonshotai',
    );
    expect(k27).toEqual({});

    const k26: Record<string, unknown> = {};
    applyOpenAICompatiblePolicy(
      k26,
      request('kimi-k2.6', { reasoning: { enabled: true, preserve: true } }),
      'moonshotai',
    );
    expect(k26['thinking']).toEqual({ type: 'enabled', keep: 'all' });
  });

  it('uses GLM toggle and limits GLM-5.2 effort', () => {
    const body: Record<string, unknown> = { reasoning_effort: 'medium' };
    applyOpenAICompatiblePolicy(
      body,
      request('glm-5.2', { reasoning: { enabled: true, effort: 'high' } }),
      'zai',
    );
    expect(body).toEqual({ thinking: { type: 'enabled' }, reasoning_effort: 'high' });
  });

  it('drops a leaked reasoning_effort when zai thinking is explicitly disabled', () => {
    // The base builder emits effort on value alone (shouldEmitReasoningEffort
    // ignores `enabled`), and the zai-glm quirk early-returns on
    // enabled === false — so on this path any present effort is a base-builder
    // leak that would ship alongside thinking:{type:'disabled'} as a
    // contradictory payload. applyZai must delete it.
    const body: Record<string, unknown> = { reasoning_effort: 'high' };
    applyOpenAICompatiblePolicy(
      body,
      request('glm-5.2', { reasoning: { enabled: false, effort: 'high' } }),
      'zai',
    );
    expect(body).toEqual({ thinking: { type: 'disabled' } });
  });

  it('maps Alibaba thinking to enable_thinking and a bounded budget', () => {
    const body: Record<string, unknown> = { reasoning_effort: 'high', tool_choice: 'required' };
    const req = request('qwen3.7-plus', {
      reasoning: { enabled: true, effort: 'high' },
      tools: [{ name: 'read', description: 'Read', inputSchema: {} }],
      toolChoice: 'required',
    });
    applyOpenAICompatiblePolicy(body, req, 'alibaba-token-plan');
    expect(body).toMatchObject({
      enable_thinking: true,
      thinking_budget: 8000,
      tool_choice: 'auto',
    });
    expect(body).not.toHaveProperty('reasoning_effort');
  });

  it('filters Grok-incompatible parameters and exact effort', () => {
    const body: Record<string, unknown> = {
      reasoning_effort: 'none',
      presence_penalty: 1,
      frequency_penalty: 1,
      stop: ['END'],
    };
    applyOpenAICompatiblePolicy(
      body,
      request('grok-4.5', { reasoning: { effort: 'medium' } }),
      'xai',
    );
    expect(body).toEqual({ reasoning_effort: 'medium' });
  });

  it('uses Groq model-specific effort and parsed reasoning with tools', () => {
    const body: Record<string, unknown> = { reasoning_effort: 'high' };
    applyOpenAICompatiblePolicy(
      body,
      request('qwen/qwen3.6-27b', {
        reasoning: { enabled: true },
        tools: [{ name: 'read', description: 'Read', inputSchema: {} }],
      }),
      'groq',
    );
    // Enabled without a representable level → omit rather than invent
    // 'default', which is not in Groq's documented enum.
    expect(body).toEqual({ reasoning_format: 'parsed' });
  });

  it('maps representable Groq efforts onto the documented enum', () => {
    const body: Record<string, unknown> = { reasoning_effort: 'high' };
    applyOpenAICompatiblePolicy(
      body,
      request('qwen/qwen3.6-27b', { reasoning: { effort: 'medium' } }),
      'groq',
    );
    expect(body['reasoning_effort']).toBe('medium');

    const off: Record<string, unknown> = {};
    applyOpenAICompatiblePolicy(
      off,
      request('qwen/qwen3.6-27b', { reasoning: { enabled: false } }),
      'groq',
    );
    expect(off['reasoning_effort']).toBe('none');
  });

  it('limits Perplexity reasoning effort to reasoning and research models', () => {
    const reasoning: Record<string, unknown> = { reasoning_effort: 'high' };
    applyOpenAICompatiblePolicy(
      reasoning,
      request('sonar-reasoning-pro', { reasoning: { effort: 'medium' } }),
      'perplexity',
    );
    expect(reasoning).toEqual({ reasoning_effort: 'medium' });

    const plain: Record<string, unknown> = { reasoning_effort: 'high' };
    applyOpenAICompatiblePolicy(
      plain,
      request('sonar-pro', { reasoning: { effort: 'high' } }),
      'perplexity',
    );
    expect(plain).toEqual({});
  });
});
