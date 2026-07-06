import { describe, expect, it } from 'vitest';
import {
  MODEL_PROFILES,
  TASK_TO_ROLE,
  findModelProfile,
  inferTaskType,
  scoreModelForTask,
} from '../../src/models/model-intelligence.js';

describe('inferTaskType', () => {
  it('maps keywords to task types', () => {
    expect(inferTaskType('design the system architecture')).toBe('planning');
    expect(inferTaskType('check for an auth vuln')).toBe('security');
    expect(inferTaskType('write a tutorial doc')).toBe('docs');
    expect(inferTaskType('add a spec with coverage')).toBe('testing');
    expect(inferTaskType('refactor and clean up')).toBe('refactoring');
    expect(inferTaskType('fix the crash bug')).toBe('debugging');
    expect(inferTaskType('parse the json data')).toBe('data');
    expect(inferTaskType('build a react component')).toBe('frontend');
    expect(inferTaskType('add an api endpoint')).toBe('backend');
    expect(inferTaskType('audit this pull request')).toBe('review');
    expect(inferTaskType('a simple change')).toBe('lightweight');
  });

  it('falls back to the role mapping when no keyword matches', () => {
    expect(inferTaskType('do the thing', 'planner')).toBe('planning');
    expect(inferTaskType('do the thing', 'security-scanner')).toBe('security');
  });

  it('falls back to general when nothing matches', () => {
    expect(inferTaskType('do the thing')).toBe('general');
    expect(inferTaskType('do the thing', 'unknown-role')).toBe('general');
  });

  it('every TaskType has a role mapping', () => {
    for (const tt of Object.keys(TASK_TO_ROLE)) {
      expect(TASK_TO_ROLE[tt as keyof typeof TASK_TO_ROLE].length).toBeGreaterThan(0);
    }
  });
});

describe('findModelProfile', () => {
  it('matches a provider + model id by pattern', () => {
    expect(findModelProfile('anthropic', 'claude-opus-4-8')?.family).toBe('Claude Opus');
    expect(findModelProfile('openai', 'gpt-4o-mini')?.family).toMatch(/Mini|GPT-4/);
    expect(findModelProfile('google', 'gemini-2.5-pro')?.family).toBe('Gemini 2.5 / 3');
    expect(findModelProfile('deepseek', 'deepseek-r1')?.family).toContain('DeepSeek');
  });

  it('matches the openrouter catch-all for any model id', () => {
    expect(findModelProfile('openrouter', 'whatever/model')?.family).toContain('OpenRouter');
  });

  it('returns undefined for an unknown provider', () => {
    expect(findModelProfile('nonexistent', 'x')).toBeUndefined();
  });

  it('returns undefined when no pattern matches within a provider', () => {
    expect(findModelProfile('anthropic', 'not-a-claude-model')).toBeUndefined();
  });

  it('every profile has the required shape', () => {
    for (const p of MODEL_PROFILES) {
      expect(p.pattern).toBeInstanceOf(RegExp);
      expect(p.bestFor.length).toBeGreaterThan(0);
    }
  });
});

describe('scoreModelForTask', () => {
  const opus = findModelProfile('anthropic', 'claude-opus-4-8');
  const haiku = findModelProfile('anthropic', 'claude-haiku-4-5');
  const standardFast = findModelProfile('openai', 'gpt-4o');

  it('returns a neutral score for an unknown model', () => {
    expect(scoreModelForTask(undefined, 'coding')).toBe(50);
  });

  it('returns a very low score for an explicitly avoided task', () => {
    expect(scoreModelForTask(haiku, 'planning')).toBe(10); // haiku avoidFor planning
  });

  it('scores best-for tasks high, earlier entries higher', () => {
    // opus.bestFor = ['planning','security','debugging','review']
    expect(scoreModelForTask(opus, 'planning')).toBe(90);
    expect(scoreModelForTask(opus, 'security')).toBe(80);
    expect(scoreModelForTask(opus, 'debugging')).toBe(70);
  });

  it('boosts budget/fast models for lightweight tasks', () => {
    // haiku is budget+fast but avoidFor doesn't include lightweight; it's bestFor lightweight → 90
    expect(scoreModelForTask(haiku, 'lightweight')).toBe(90);
    // standardFast: lightweight not in bestFor/avoidFor → base 50 + standard(15) + fast(20) = 85
    expect(scoreModelForTask(standardFast, 'lightweight')).toBe(85);
  });

  it('boosts premium/slow models for planning and security via the cost path', () => {
    // standardFast for 'security' is not bestFor/avoidFor → base 50, standard cost (+0), fast (+0) = 50
    expect(scoreModelForTask(standardFast, 'security')).toBe(50);
    // A premium+slow model scored on an off-list task gets the premium/slow boosts.
    const premiumSlow = { ...opus!, bestFor: [], avoidFor: [] };
    expect(scoreModelForTask(premiumSlow, 'planning')).toBe(50 + 20 + 10);
  });
});
