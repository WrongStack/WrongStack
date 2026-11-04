// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { usagePricing } from '../../../packages/webui-server/src/server/usage-pricing';
import type { DelegationRecord } from '../src/delegations';
import { SessionUsage } from '../src/SessionUsage';
import { surfaceI18n } from '../src/surface-i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function stats() {
  const usage = { input: 220, output: 25, cacheRead: 480, cacheWrite: 0 };
  return {
    sessionId: 'owner',
    provider: 'local',
    model: 'model',
    usage,
    cache: {
      readTokens: 480,
      writeTokens: 0,
      hitRatio: 480 / 700,
      savedUsd: 0,
      last: { input: 120, cacheRead: 480, cacheWrite: 0, hitRatio: 0.8 },
      providers: [
        { provider: 'local', input: 220, cacheRead: 480, cacheWrite: 0, hitRatio: 480 / 700 },
      ],
    },
    currentRequest: { input: 30, cacheRead: 0, cacheWrite: 0 },
    pricing: usagePricing(usage, { cost: { input: 2, output: 4, cache_read: 0.2 } }),
  };
}

const delegations = [
  {
    id: 'd1',
    target: 'claude-code',
    ok: false,
    status: 'timeout',
    iterations: 3,
    toolCalls: 4,
    durationMs: 12_000,
    costUsd: null,
    summary: '',
  },
] as unknown as DelegationRecord[];

async function render() {
  const host = document.createElement('div');
  document.body.append(host);
  let root: Root | undefined;
  await act(async () => {
    root = createRoot(host);
    root.render(
      createElement(SessionUsage, {
        sessionId: 'owner',
        sessionTitle: 'Fix login',
        connected: true,
        command: vi.fn(async () => stats()),
        onBack: () => undefined,
        delegations,
      }),
    );
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

describe('conversation usage in the display language', () => {
  afterAll(async () => {
    await surfaceI18n.changeLanguage('en');
  });

  it('keeps the English page and translates it in Turkish', async () => {
    await surfaceI18n.changeLanguage('en');
    const english = await render();
    for (const text of [
      'Usage & cost',
      'Accumulated token traffic',
      '725 tokens',
      'Fresh input',
      'Request cache hit',
      'Cache over this session',
      'Estimate at current model rates',
      'Catalog / saved override',
      'Conversation footprint',
      'Worker delegations',
      '1 finished · 1 not successful · 4 tool calls · 12 s · 1 without a cost estimate. As reported',
      'Did not succeed (timeout) · 3 turns · 4 tool calls · 12 s',
    ])
      expect(english.text).toContain(text);
    expect(english.labels).toEqual(
      expect.arrayContaining([
        'Conversation usage and cost',
        'Session token totals',
        'Last provider-reported request',
        'Finished delegations',
      ]),
    );
    await surfaceI18n.changeLanguage('tr');
    const turkish = await render();
    for (const text of [
      'Kullanım ve maliyet',
      'Biriken token trafiği',
      '725 token',
      'Yeni girdi',
      'İstek önbellek isabeti',
      'Bu oturumdaki önbellek',
      'Geçerli model fiyatlarıyla tahmin',
      'Katalog / kayıtlı geçersiz kılma',
      'Konuşma ayak izi',
      'İşçi delegasyonları',
      '1 tamamlandı · 1 başarısız · 4 araç çağrısı · 12 sn · maliyet tahmini olmayan 1.',
      'Başarılı olmadı (timeout) · 3 tur · 4 araç çağrısı · 12 sn',
    ])
      expect(turkish.text).toContain(text);
    expect(turkish.labels).toEqual(
      expect.arrayContaining(['Konuşma kullanımı ve maliyeti', 'Tamamlanan delegasyonlar']),
    );
  });
});
