// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import {
  WorkspacePreferencesProvider,
  WorkspaceViewMenu,
} from '../src/components/workspace-preferences';
import { WORKSPACE_PREFERENCES_KEY } from '../src/lib/workspace-preferences';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.innerHTML = '';
  localStorage.removeItem(WORKSPACE_PREFERENCES_KEY);
});

async function renderTrigger(view: string) {
  localStorage.setItem(WORKSPACE_PREFERENCES_KEY, JSON.stringify({ view }));
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(
      createElement(
        WorkspacePreferencesProvider,
        null,
        createElement(WorkspaceViewMenu, { onChoose: () => {} }),
      ),
    );
  });
  const trigger = host.querySelector<HTMLButtonElement>('button.view-trigger');
  expect(trigger, 'the view trigger renders').not.toBeNull();
  expect(trigger!.disabled, 'the view trigger is enabled').toBe(false);
  const visible = trigger!.textContent?.trim() ?? '';
  const accessibleName = trigger!.getAttribute('aria-label') ?? visible;
  return { visible, accessibleName };
}

describe('workspace view trigger name (WCAG 2.5.3)', () => {
  it.each([
    ['cozy', 'Cozy chat'],
    ['focus', 'Just chat'],
    ['studio', 'Studio'],
  ])('keeps the visible %s label in the accessible name', async (view, label) => {
    const { visible, accessibleName } = await renderTrigger(view);
    expect(visible).toBe(label);
    expect(accessibleName).toContain(visible);
  });
});
