// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { SettingsSearch } from '../src/components/settings-search';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.innerHTML = '';
});

async function mountSearch() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(
      createElement(
        SettingsSearch,
        null,
        createElement(
          'div',
          { className: 'settings-row' },
          createElement('strong', null, 'Appearance'),
          createElement('small', null, 'Theme settings'),
        ),
      ),
    );
  });
  const input = host.querySelector<HTMLInputElement>('input[aria-label="Search settings"]');
  expect(input, 'search input renders').not.toBeNull();
  expect(host.textContent, 'settings content renders').toContain('Appearance');
  return input!;
}

describe('settings search status messages (WCAG 4.1.3)', () => {
  it('mounts an empty status region before the first query and updates it in place', async () => {
    const input = await mountSearch();
    const status = document.querySelector<HTMLElement>('[role="status"]');
    expect(status, 'status region exists at mount').not.toBeNull();
    expect(status!.textContent, 'status starts empty').toBe('');

    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(input, 'theme');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(document.querySelector('[role="status"]'), 'status region is not remounted').toBe(
      status,
    );
    expect(status!.textContent).toContain('1 matching settings');
  });
});
