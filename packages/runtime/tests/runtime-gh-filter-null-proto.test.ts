import { describe, expect, it } from 'vitest';
import { evaluateGitHubFilters } from '../src/automation/github-filters.js';

describe('evaluateGitHubFilters null-prototype sender.type guard (F2242)', () => {
  it('treats null-prototype sender.type as bot without throwing TypeError', () => {
    const res = evaluateGitHubFilters(
      { excludeBots: true },
      { sender: { type: Object.create(null), login: 'alice' } },
    );
    expect(res.matches).toBe(false);
    expect(res.reasons).toContain('bot');
  });
});
