// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { BrainRules } from '../src/BrainRules';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mount(snapshot: Record<string, unknown>) {
  const host = document.createElement('div');
  act(() => createRoot(host).render(createElement(BrainRules, { snapshot })));
  return host;
}

describe('Brain deterministic rules', () => {
  it('lists configured rules in order with their action and an off mark', () => {
    const host = mount({
      rules: [
        // biome-ignore lint/suspicious/noThenProperty: BrainRule's domain contract names this action field `then`.
        { id: 'deny-force-push', then: { action: 'deny' } },
        // biome-ignore lint/suspicious/noThenProperty: BrainRule's domain contract names this action field `then`.
        { id: 'allow-tests', enabled: false, then: { action: 'allow' } },
      ],
      ruleErrors: [],
    });
    expect(host.textContent).toContain('2 configured');
    const items = [...host.querySelectorAll('li')].map((item) => item.textContent);
    expect(items).toEqual(['deny-force-pushdeny', 'allow-testsallowoff']);
    expect(host.querySelector('[role="note"]')).toBeNull();
  });

  it('names the rules the loader dropped', () => {
    const host = mount({ rules: [], ruleErrors: ['rule 3: unknown action "maybe"'] });
    expect(host.textContent).toContain('0 configured');
    expect(host.querySelector('[role="note"]')?.textContent).toBe(
      '1 rule droppedrule 3: unknown action "maybe"',
    );
  });
});
