import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DraftCounter } from '../src/DraftCounter';

const render = (draft: string, tokens = 0, max = 0) =>
  renderToStaticMarkup(createElement(DraftCounter, { draft, context: { tokens, max } }));

describe('draft counter', () => {
  it('counts characters, and estimates tokens only for a long draft', () => {
    expect(render('')).toBe('');
    expect(render('fix it')).toBe('<span class="draft-counter">6</span>');
    const long = render('x'.repeat(800));
    expect(long).toContain('<span> · ≈200 tokens</span>');
    expect(long).toContain('title="≈ 200 tokens (4 characters a token)"');
    expect(render('x'.repeat(8000))).toContain('≈2.0k tokens');
  });

  it('projects the context use and warns when it gets tight or overflows', () => {
    const draft = 'x'.repeat(800);
    // Numbers follow the display language, not the operating system's locale.
    const max = (2_000).toLocaleString('en');
    expect(render(draft, 1_000, 2_000)).toContain(`projected 63% of the ${max}-token context`);
    expect(render(draft, 1_700, 2_000)).toMatch(/class="draft-counter tight" title="Projected 98%/);
    expect(render(draft, 1_900, 2_000)).toContain(
      `class="draft-counter over" title="Projected 108% of the ${max}-token context: the request will likely fail or compact."`,
    );
  });
});
