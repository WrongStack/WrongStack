// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { FallbackSuggestions } from '../src/FallbackSuggestions';
import { SessionMcpTasks } from '../src/SessionMcpTasks';
import { SessionPlanTemplates } from '../src/SessionPlanTemplates';
import { surfaceI18n } from '../src/surface-i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function view(element: ReturnType<typeof createElement>, click?: string) {
  const host = document.createElement('div');
  document.body.append(host);
  let root: Root | undefined;
  await act(async () => {
    root = createRoot(host);
    root.render(element);
  });
  const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  await settle();
  if (click) {
    const button = [...host.querySelectorAll('button')].find((b) => b.textContent === click);
    await act(async () => button?.click());
    await settle();
  }
  const text = host.textContent ?? '';
  const labels = [...host.querySelectorAll('[aria-label],[title],[placeholder]')].flatMap((n) => [
    n.getAttribute('aria-label') ?? '',
    n.getAttribute('title') ?? '',
    n.getAttribute('placeholder') ?? '',
  ]);
  act(() => root?.unmount());
  host.remove();
  return { text, labels };
}

const templates = () =>
  createElement(SessionPlanTemplates, {
    command: vi.fn(async () => ({
      templates: [
        { name: 'new-feature', category: 'dev', items: [{ title: 'Spec', details: '' }] },
      ],
    })),
    running: true,
    onBack: () => undefined,
  });

const suggestions = (click: string) =>
  view(
    createElement(FallbackSuggestions, {
      command: vi.fn(async () => ({
        suggestions: [
          { id: 'balanced', chain: ['a/m1', 'b/m2'], score: 1, providerCount: 2, source: 'llm' },
        ],
        candidateCount: 2,
      })),
      draft: {},
      onUse: () => undefined,
      onSaveProfile: () => undefined,
    }),
    click,
  );

const task = {
  id: 'task-1',
  server: 'srv',
  tool: 'build',
  status: 'input_required',
  createdAt: '2026-11-04T10:00:00.000Z',
  lastUpdatedAt: '2026-11-04T10:01:00.000Z',
  delivered: false,
  observing: false,
};
const tasks = () =>
  createElement(SessionMcpTasks, {
    sessionId: 's1',
    connected: true,
    command: vi.fn(async () => ({ sessionId: 's1', tasks: [task] })),
    onBack: () => undefined,
    pendingReviews: 1,
  });

describe('session panels in the display language', () => {
  afterAll(async () => {
    await surfaceI18n.changeLanguage('en');
  });

  it('keeps English and translates plan templates, chain suggestions and MCP tasks in Turkish', async () => {
    await surfaceI18n.changeLanguage('en');
    const plan = await view(templates());
    expect(plan.labels).toEqual(
      expect.arrayContaining([
        'Plan templates',
        'Steps of New feature',
        'Wait until the current turn ends.',
      ]),
    );
    expect(plan.text).toContain('Back to conversation');
    expect(plan.text).toContain('Add to plan');
    const chains = await suggestions('Suggest chains');
    expect(chains.text).toContain('balanced · 2 providers · ranked by the model');
    expect(chains.text).toContain('Save as profile suggested-balanced');
    const mcp = await view(tasks());
    expect(mcp.text).toContain('1 recorded1 active1 need input');
    expect(mcp.text).toContain('Needs input');
    expect(mcp.text).toContain('Review pending session requests (1)');
    expect(mcp.text).toContain('Resume observation');
    expect(mcp.labels).toEqual(
      expect.arrayContaining(['Session MCP tasks', 'Server, tool or task ID…']),
    );

    await surfaceI18n.changeLanguage('tr');
    const turkishPlan = await view(templates());
    expect(turkishPlan.labels).toEqual(
      expect.arrayContaining([
        'Plan şablonları',
        'New feature adımları',
        'Geçerli tur bitene kadar bekle.',
      ]),
    );
    expect(turkishPlan.text).toContain('Konuşmaya dön');
    expect(turkishPlan.text).toContain('Plana ekle');
    const turkishChains = await suggestions('Zincir öner');
    expect(turkishChains.text).toContain('balanced · 2 sağlayıcı · model tarafından sıralandı');
    expect(turkishChains.text).toContain('suggested-balanced profili olarak kaydet');
    const turkishMcp = await view(tasks());
    expect(turkishMcp.text).toContain('1 kayıtlı1 etkin1 girdi bekliyor');
    expect(turkishMcp.text).toContain('Girdi bekliyor');
    expect(turkishMcp.text).toContain('Bekleyen oturum isteklerini incele (1)');
    expect(turkishMcp.text).toContain('Gözlemi sürdür');
    expect(turkishMcp.labels).toEqual(
      expect.arrayContaining(['Oturum MCP görevleri', 'Sunucu, araç veya görev kimliği…']),
    );
  });
});
