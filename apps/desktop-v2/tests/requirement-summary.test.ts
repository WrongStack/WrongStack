import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RequirementSummary } from '../src/RequirementSummary';
import { isVibeIntake, readable, strings, text } from '../src/requirement-values';

const render = (detail: Record<string, unknown>) =>
  renderToStaticMarkup(createElement(RequirementSummary, { detail }));

describe('requirement summary', () => {
  it('shows the original request with a copy action, and the summary only when it differs', () => {
    const markup = render({
      originalRequest: 'Add CSV export',
      normalizedSummary: 'Add CSV export',
      priority: 'high',
      targetUsers: ['analysts', 3],
    });
    expect(markup).toContain('Add CSV export');
    expect(markup).toContain('aria-label="Copy the original request"');
    expect(markup).not.toContain('<h4>Summary</h4>');
    expect(markup).toContain('<li>analysts</li>');
    expect(markup).not.toContain('<li>3</li>');
    expect(render({ originalRequest: 'a', normalizedSummary: 'b' })).toContain('<h4>Summary</h4>');
  });

  it('names the VIBE protocol when the request runs under it, and says so for the rest', () => {
    expect(render({ isVibeMode: true })).toContain('VIBE three-stage verification');
    expect(render({})).toContain('Standard');
    expect(render({})).toContain('Not recorded');
  });
});

describe('requirement values', () => {
  it('reads text, lists, enum words and the VIBE flag defensively', () => {
    expect(text(4)).toBe('');
    expect(strings(['a', null, 'b'])).toEqual(['a', 'b']);
    expect(strings('a')).toEqual([]);
    expect(readable('bug_fix')).toBe('bug fix');
    expect(readable(undefined)).toBe('Not reported');
    expect(isVibeIntake({ isVibeMode: 'yes' })).toBe(false);
  });
});
