import type { TodoItem } from '@wrongstack/core/agent';
import { describe, expect, it, vi } from 'vitest';
import {
  buildPredictionPrompt,
  type PredictLLMProvider,
  parsePredictions,
  predictNextTasks,
} from '../src/next-task-predictor.js';

const todo = (content: string, status: TodoItem['status'] = 'pending'): TodoItem => ({
  id: `t_${content}`,
  content,
  status,
});

describe('parsePredictions', () => {
  it('parses a numbered list', () => {
    const out = parsePredictions('1. Add tests\n2. Wire the command\n3. Update docs');
    expect(out).toEqual(['Add tests', 'Wire the command', 'Update docs']);
  });

  it('handles bullet and paren markers', () => {
    expect(parsePredictions('- foo\n* bar\n3) baz')).toEqual(['foo', 'bar', 'baz']);
  });

  it('caps at the requested max', () => {
    const out = parsePredictions('1. a\n2. b\n3. c\n4. d', 2);
    expect(out).toEqual(['a', 'b']);
  });

  it('returns [] for the NONE sentinel', () => {
    expect(parsePredictions('NONE')).toEqual([]);
    expect(parsePredictions('No further steps needed.')).toEqual([]);
  });

  it('returns [] for empty input', () => {
    expect(parsePredictions('   ')).toEqual([]);
  });

  it('keeps unmarked lines verbatim', () => {
    expect(parsePredictions('Run the test suite')).toEqual(['Run the test suite']);
  });
});

describe('buildPredictionPrompt', () => {
  it('includes the user request and assistant summary', () => {
    const prompt = buildPredictionPrompt({
      userRequest: 'add a parser',
      assistantSummary: 'I added parse.ts',
      todos: [],
    });
    expect(prompt).toContain('add a parser');
    expect(prompt).toContain('I added parse.ts');
    expect(prompt).toContain('submit back to the agent through the TUI or WebUI');
    expect(prompt).toContain('never assign a manual chore to the user');
  });

  it('lists only pending todos', () => {
    const prompt = buildPredictionPrompt({
      userRequest: 'x',
      assistantSummary: '',
      todos: [todo('write tests'), todo('done thing', 'completed')],
    });
    expect(prompt).toContain('write tests');
    expect(prompt).not.toContain('done thing');
  });

  it('handles empty user request gracefully', () => {
    const prompt = buildPredictionPrompt({ userRequest: '', assistantSummary: '', todos: [] });
    expect(prompt).toContain('(no text)');
  });
});

describe('predictNextTasks', () => {
  it('returns parsed predictions from the provider', async () => {
    const provider: PredictLLMProvider = {
      complete: vi.fn(async () => ({
        content: [{ type: 'text' as const, text: '1. Add tests\n2. Update docs' }],
        model: 'm',
      })),
    };
    const out = await predictNextTasks(
      { userRequest: 'do X', assistantSummary: 'did X', todos: [] },
      { provider, model: 'm' },
    );
    expect(out).toEqual(['Add tests', 'Update docs']);
    expect(provider.complete).toHaveBeenCalledTimes(1);
  });

  it('returns [] when the provider throws', async () => {
    const provider: PredictLLMProvider = {
      complete: vi.fn(async () => {
        throw new Error('boom');
      }),
    };
    const out = await predictNextTasks(
      { userRequest: 'x', assistantSummary: '', todos: [] },
      { provider, model: 'm' },
    );
    expect(out).toEqual([]);
  });

  it('respects maxPredictions', async () => {
    const provider: PredictLLMProvider = {
      complete: vi.fn(async () => ({
        content: [{ type: 'text' as const, text: '1. a\n2. b\n3. c' }],
        model: 'm',
      })),
    };
    const out = await predictNextTasks(
      { userRequest: 'x', assistantSummary: '', todos: [] },
      { provider, model: 'm', maxPredictions: 1 },
    );
    expect(out).toEqual(['a']);
  });
});
