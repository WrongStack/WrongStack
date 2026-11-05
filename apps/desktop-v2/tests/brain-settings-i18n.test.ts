// @vitest-environment jsdom

import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { BrainPolicySettings } from '../src/BrainPolicySettings';
import { BrainTargetEditor } from '../src/BrainTargetEditor';
import { surfaceI18n } from '../src/surface-i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Renders a page after its first replies arrive, then reads its text and accessible names. */
async function mount(page: ReactElement) {
  const host = document.createElement('div');
  document.body.append(host);
  let root: Root | undefined;
  await act(async () => {
    root = createRoot(host);
    root.render(page);
  });
  await act(async () => {});
  const text = host.textContent ?? '';
  const labels = [...host.querySelectorAll('[aria-label]')].map((node) =>
    node.getAttribute('aria-label'),
  );
  act(() => root?.unmount());
  host.remove();
  return { text, labels };
}

// One pool model, one voter using a catalog lens, one empty seat default and no judge.
const targets = () =>
  createElement(BrainTargetEditor, {
    value: {
      strategy: 'fallback',
      pool: [{ provider: 'zai', model: 'glm' }],
      voters: [{ provider: '', model: '', persona: 'skeptic', weight: '', veto: 'default' }],
      seats: [{ persona: '', veto: 'default' }],
      judge: { provider: '', model: '' },
    },
    onChange: vi.fn(),
    snapshot: {
      personaCatalog: [
        { id: 'skeptic', name: 'Skeptic', description: 'Looks for flaws.', defaultVeto: true },
      ],
    },
    command: vi.fn(async (type: string) => (type === 'providers.saved' ? { providers: [] } : {})),
  });

// A readable Brain configuration: cache counts, an active council with a voter, a seat default
// and a judge, one rule with a condition and a limit, one dropped rule, and a ledger location.
const policy = () =>
  createElement(BrainPolicySettings, {
    command: vi.fn(async (type: string) =>
      type === 'brain.config.get'
        ? {
            config: {
              maxAutoRisk: 'medium',
              mode: 'interactive',
              models: [],
              cache: { hits: 3, misses: 1, size: 2 },
              council: {
                enabled: true,
                voters: [
                  { provider: 'zai', model: 'glm', persona: 'skeptic', weight: 2, veto: true },
                ],
                seats: [{ persona: 'auditor' }],
                judge: { model: 'glm' },
              },
              councilLabels: ['zai/glm'],
              judgeLabel: 'zai/glm',
              judgeIsVoter: true,
              rules: [
                {
                  id: 'deny-rm',
                  when: { risk: 'high' },
                  // biome-ignore lint/suspicious/noThenProperty: BrainRule's domain contract names this action field `then`.
                  then: { action: 'deny', reason: 'Destructive' },
                  maxHits: 2,
                  windowMs: 1000,
                },
              ],
              ledger: { path: 'C:/brain/ledger.jsonl' },
              trace: {},
              ruleErrors: ['rule 2 has no action'],
            },
          }
        : type === 'providers.saved'
          ? { providers: [] }
          : {},
    ),
  });

describe('the Brain settings in the display language', () => {
  afterAll(() => surfaceI18n.changeLanguage('en'));

  it('show the models and council editor in English, then in Turkish', async () => {
    await surfaceI18n.changeLanguage('en');
    let page = await mount(targets());
    for (const text of [
      'Decision model pool',
      'Fallback in order',
      'Pool model 1',
      'Choose from saved catalogs…',
      'Add Brain pool model',
      'Council voting seats',
      'Voting seat 1',
      'Vote weight',
      'Inherit seat / lens default',
      'Looks for flaws.',
      'Seat defaults',
      'A decision lens is required.',
      'No veto default is reported for this lens; the engine resolves it.',
      'Council judge',
      'Use derived judge',
    ])
      expect(page.text).toContain(text);
    expect(page.labels).toEqual(
      expect.arrayContaining([
        'Brain models and council editor',
        'Brain pool model 1 saved model',
        'Move Brain pool model 1 up',
        'Brain voter 1 lens',
        'Remove Brain seat default 1',
        'Council judge model ID',
      ]),
    );

    await surfaceI18n.changeLanguage('tr');
    page = await mount(targets());
    for (const text of [
      'Karar modeli havuzu',
      'Sırayla yedekle',
      'Havuz modeli 1',
      'Kayıtlı kataloglardan seç…',
      'Brain havuzuna model ekle',
      'Konsey oy koltukları',
      'Oy koltuğu 1',
      'Oy ağırlığı',
      'Koltuk / mercek varsayılanını devral',
      'Koltuk varsayılanları',
      'Bir karar merceği gerekli.',
      'Bu mercek için varsayılan veto bildirilmedi; motor bunu çözer.',
      'Konsey hakemi',
      'Türetilen hakemi kullan',
    ])
      expect(page.text).toContain(text);
    expect(page.labels).toEqual(
      expect.arrayContaining([
        'Brain modelleri ve konsey düzenleyicisi',
        'Brain havuz modeli 1 kayıtlı modeli',
        'Yukarı taşı: Brain havuz modeli 1',
        'Brain oy vericisi 1 merceği',
        'Kaldır: Brain koltuk varsayılanı 1',
        'Konsey hakemi model kimliği',
      ]),
    );
  });

  it('show the Brain policy page in English, then in Turkish', async () => {
    await surfaceI18n.changeLanguage('en');
    let page = await mount(policy());
    for (const text of [
      'ACTIVE PROFILE · DECISION POLICY',
      'Refresh Brain policy',
      '3 cache hits',
      'Active effective council',
      'Deterministic rules',
      '1 configured',
      '1 rule dropped',
      'Jump to section',
      'Models & council',
      'Risk & escalation',
      'Automatic risk ceiling',
      'Maximum risk considered by the model decision tier.',
      'deny all',
      'continue on recommended',
      'This profile inherits the engine monitor defaults.',
      'Enable Brain monitor',
      'Brain policy matches saved values',
      'Save Brain policy',
      'Models & council seats',
      'Inherit the runtime’s model selection.',
      'skeptic · vote weight 2 · veto enabled',
      'auditor · use lens veto default',
      'Configured judge: glm',
      'Effective judge: zai/glm · also a voting member',
      'deny-rm · Enabled',
      'Decision: deny',
      'Reason: Destructive',
      'Maximum 2 matches per 1000 ms.',
      'Evidence locations',
      'No location reported',
    ])
      expect(page.text).toContain(text);
    expect(page.labels).toEqual(
      expect.arrayContaining([
        'Brain policy settings',
        'Brain policy groups',
        'Automatic risk ceiling',
        'Deterministic rules',
        'Effective decision models',
        'Brain evidence locations',
      ]),
    );

    await surfaceI18n.changeLanguage('tr');
    page = await mount(policy());
    for (const text of [
      'ETKİN PROFİL · KARAR POLİTİKASI',
      'Brain politikasını yenile',
      '3 önbellek isabeti',
      'Geçerli konsey: Etkin',
      'Deterministik kurallar',
      '1 yapılandırıldı',
      '1 kural atlandı',
      'Bölüme git',
      'Modeller ve konsey',
      'Risk ve yükseltme',
      'Otomatik risk tavanı',
      'Model karar katmanının dikkate aldığı en yüksek risk.',
      'hepsini reddet',
      'Bu profil motorun monitör varsayılanlarını devralır.',
      'Brain monitörünü etkinleştir',
      'Brain politikası kayıtlı değerlerle eşleşiyor',
      'Brain politikasını kaydet',
      'Modeller ve konsey koltukları',
      'Çalışma zamanının model seçimini devral.',
      'skeptic · oy ağırlığı 2 · veto etkin',
      'auditor · mercek veto varsayılanını kullan',
      'Yapılandırılmış hakem: glm',
      'Geçerli hakem: zai/glm · aynı zamanda oy veren üye',
      'deny-rm · Etkin',
      'Karar: deny',
      'Neden: Destructive',
      '1000 ms başına en fazla 2 eşleşme.',
      'Kanıt konumları',
      'Konum bildirilmedi',
    ])
      expect(page.text).toContain(text);
    expect(page.labels).toEqual(
      expect.arrayContaining([
        'Brain politikası ayarları',
        'Brain politikası grupları',
        'Otomatik risk tavanı',
        'Deterministik kurallar',
        'Geçerli karar modelleri',
        'Brain kanıt konumları',
      ]),
    );
  });
});
