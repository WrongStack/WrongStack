// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { ModelCatalogSettings } from '../src/ModelCatalogSettings';
import { surfaceI18n } from '../src/surface-i18n';

const bridge = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../src/platform', () => ({ request: bridge.request, native: true }));
let nextProfile = 0;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) {
  this.open = true;
};
HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement) {
  this.open = false;
};

describe('verified model save and draft cleanup', () => {
  it.each([
    { scenario: 'successful cleanup', fails: false, retry: null },
    { scenario: 'cleanup refusal', fails: true, retry: null },
    { scenario: 'a second edit', fails: true, retry: 'save' },
    { scenario: 'closing the retained editor', fails: true, retry: 'close' },
    { scenario: 'a newer saved definition', fails: true, retry: 'conflict' },
  ])('handles $scenario after a verified save', async ({ fails, retry }) => {
    await surfaceI18n.changeLanguage('en');
    vi.stubGlobal('crypto', webcrypto);
    let refuseCleanup = fails;
    const drafts = new Map<string, { revision: number; value: unknown }>();
    bridge.request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      const key = String(params.formKey);
      const draft = drafts.get(key) ?? { revision: 0, value: null };
      if (method === 'profile-draft.get') return structuredClone(draft);
      if (method !== 'profile-draft.save') throw Error('Unexpected native call ' + method);
      if (draft.revision !== params.expectedRevision) throw Error('DRAFT_CONFLICT');
      if (params.value === null && refuseCleanup) throw Error('Fixture draft cleanup refused');
      const revision = draft.revision + 1;
      drafts.set(key, { revision, value: structuredClone(params.value) });
      return { revision };
    });
    const providerId = 'fixture-provider';
    const modelId = 'fixture/local-model';
    const profileId = String(++nextProfile).padStart(64, '0');
    const models: Record<string, unknown> = {};
    let refreshes = 0;
    let modelWrites = 0;
    const command = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === 'prefs.get')
        return {
          profileIdentity: { id: profileId, name: 'Draft fixture' },
        };
      if (method === 'providers.list') return { providers: [{ id: providerId, name: 'Fixture' }] };
      if (method === 'providers.saved')
        return {
          providers: [{ id: providerId, customModels: structuredClone(models) }],
        };
      if (method === 'provider.models') {
        refreshes++;
        return { provider: providerId, models: [] };
      }
      if (method === 'provider.custom_models.set') {
        modelWrites++;
        models[String(params.modelId)] = structuredClone(params.customModel);
        return { ok: true };
      }
      throw Error('Unexpected engine request ' + method);
    });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(createElement(ModelCatalogSettings, { command })));
      const add = [...host.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === 'Add model definition',
      );
      expect(add).toBeDefined();
      await vi.waitFor(async () => {
        await act(async () => {});
        expect(add?.disabled).toBe(false);
      });
      await act(async () => add!.click());
      const form = host.querySelector<HTMLFormElement>('dialog form.model-editor')!;
      expect(form).not.toBeNull();
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      const fill = async (label: string, value: string) => {
        const input = form.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
        expect(input).not.toBeNull();
        await act(async () => {
          setValue.call(input, value);
          input.dispatchEvent(new Event('input', { bubbles: true }));
        });
      };
      const submit = () =>
        act(async () => {
          form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        });
      await fill('Model definition ID', modelId);
      await fill('Model display name', 'My verified model');
      const previousRefreshes = refreshes;
      await submit();
      expect(modelWrites).toBe(1);
      expect(models[modelId]).toMatchObject({ modelsDev: { name: 'My verified model' } });
      if (fails) {
        expect(host.querySelector('dialog form.model-editor')).not.toBeNull();
        const alert = form.querySelector('[role="alert"]');
        expect(alert?.textContent).toContain('Fixture draft cleanup refused');
        expect(alert?.textContent).toContain('Model definition saved and verified.');
        expect(alert?.textContent).toContain('Could not clear the draft.');
        expect([...drafts.values()].some(({ value }) => value !== null)).toBe(true);
      } else {
        expect(host.querySelector('dialog form.model-editor')).toBeNull();
        expect(host.querySelector('.studio-notice')?.textContent).toContain(
          'Model definition saved and verified.',
        );
        expect([...drafts.values()].every(({ value }) => value === null)).toBe(true);
      }
      expect(refreshes).toBeGreaterThan(previousRefreshes);
      refuseCleanup = false;
      if (retry === 'save' || retry === 'conflict') {
        if (retry === 'conflict')
          models[modelId] = { modelsDev: { name: 'Newer peer definition' } };
        await fill('Model display name', 'My second saved name');
        await submit();
        const alert = form.querySelector('[role="alert"]')?.textContent ?? '';
        if (retry === 'save') {
          expect(modelWrites, alert).toBe(2);
          expect(models[modelId]).toMatchObject({ modelsDev: { name: 'My second saved name' } });
          expect(host.querySelector('dialog form.model-editor')).toBeNull();
        } else {
          expect(modelWrites).toBe(1);
          expect(models[modelId]).toMatchObject({ modelsDev: { name: 'Newer peer definition' } });
          expect(alert).toContain('This model definition changed since it was opened.');
        }
      }
      if (retry === 'close') {
        const cancel = [...form.querySelectorAll('button')].find(
          (button) => button.textContent?.trim() === 'Cancel model editing',
        );
        expect(cancel).toBeDefined();
        await act(async () => cancel!.click());
        expect(form.textContent).not.toContain('Discard this unsaved model definition?');
        expect(host.querySelector('dialog form.model-editor')).toBeNull();
        expect(modelWrites).toBe(1);
        expect([...drafts.values()].every(({ value }) => value === null)).toBe(true);
      }
    } finally {
      await act(async () => root.unmount());
      host.remove();
      vi.unstubAllGlobals();
      bridge.request.mockReset();
    }
  });
});
