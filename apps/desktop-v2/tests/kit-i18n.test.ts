// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it } from 'vitest';
import { KitCreateRequest } from '../src/KitCreateRequest';
import { KitParameterForm, KitSchemaDetails, KitValue } from '../src/KitParameterForm';
import { ProjectKit } from '../src/ProjectKit';
import { type KitSchema, kitInputErrors } from '../src/project-kit-model';
import { surfaceI18n } from '../src/surface-i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const schema: KitSchema = {
  type: 'object',
  properties: {
    names: { type: 'array', items: { type: 'string' }, minItems: 1 },
    sort: { type: 'boolean' },
  },
  required: ['names'],
};

const parts = () =>
  renderToStaticMarkup(
    createElement('div', null, [
      createElement(KitParameterForm, {
        key: 'f',
        schema,
        value: { names: [] },
        onChange: () => undefined,
      }),
      createElement(KitValue, { key: 'v', value: [true, null] }),
      createElement(KitSchemaDetails, { key: 's', schema }),
      createElement(KitCreateRequest, {
        key: 'c',
        projectRoot: '',
        sessions: [],
        onPrepare: async () => true,
        onNewSession: () => undefined,
        onClose: () => undefined,
      }),
    ]),
  ).replaceAll('<!-- -->', '');

const http = (async () => ({
  tools: [{ name: 'notes', description: 'Release notes', effects: 'read' }],
  invalid: [{ name: 'broken', error: 'bad manifest' }],
  projectRoot: '',
})) as never;

async function page() {
  const host = document.createElement('div');
  const root = createRoot(host);
  await act(async () =>
    root.render(
      createElement(ProjectKit, {
        projectId: 'p1',
        http,
        sessions: [],
        onPrepare: async () => true,
        onNewSession: () => undefined,
        onOpenFile: () => undefined,
      }),
    ),
  );
  await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  const text = host.textContent ?? '';
  act(() => root.unmount());
  return text;
}

describe('Project Kit in the display language', () => {
  afterAll(async () => {
    await surfaceI18n.changeLanguage('en');
  });

  it('keeps English and translates the page, form and feedback in Turkish', async () => {
    await surfaceI18n.changeLanguage('en');
    const english = parts();
    for (const text of [
      'Include sort',
      'Add Names item',
      'Add items in the order they should be supplied.',
      'Yes',
      'Empty value',
      'Result',
      ' · required: names',
      'Minimum items 1',
      'Each item',
      'Create a kit',
      'The capability I need',
      'Create a project conversation',
    ])
      expect(english).toContain(text);
    const englishPage = await page();
    for (const text of [
      '1 kits · 1 invalid',
      'Reads project data',
      'Invalid kit definitions (1)',
      'Know exactly what your agent can run.',
    ])
      expect(englishPage).toContain(text);

    await surfaceI18n.changeLanguage('tr');
    const turkish = parts();
    for (const text of [
      'sort dahil et',
      'Names öğesi ekle',
      'Öğeleri verilmeleri gereken sırayla ekle.',
      'Evet',
      'Boş değer',
      'Sonuç',
      ' · zorunlu: names',
      'En az öğe 1',
      'Her öğe',
      'Kit oluştur',
      'İhtiyacım olan yetenek',
      'Bir proje konuşması oluştur',
    ])
      expect(turkish).toContain(text);
    const turkishPage = await page();
    for (const text of [
      '1 kit · 1 geçersiz',
      'Proje verilerini okur',
      'Geçersiz kit tanımları (1)',
      'Ajanının tam olarak neyi çalıştırabileceğini bil.',
    ])
      expect(turkishPage).toContain(text);
  });

  it('words form feedback through the catalog and keeps the English default', async () => {
    expect(kitInputErrors(schema, { names: [], extra: 1 })).toEqual([
      'Input.names: at least 1 items.',
      'Input.extra: unknown parameter.',
    ]);
    await surfaceI18n.changeLanguage('tr');
    const t = surfaceI18n.getFixedT('tr', 'desktop');
    expect(
      kitInputErrors(schema, { sort: 'x' }, t('projectKit.input'), (code, values) =>
        t(`kitErrors.${code}`, values),
      ),
    ).toEqual(['Girdi.names: zorunlu.', 'Girdi.sort: evet ya da hayır seç.']);
  });
});
