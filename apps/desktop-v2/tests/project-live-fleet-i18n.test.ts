// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { ProjectLiveFleet } from '../src/ProjectLiveFleet';
import { surfaceI18n } from '../src/surface-i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has no layout or modal dialogs; the map and the review dialog only need these to exist.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) {
  this.open = true;
};
HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement) {
  this.open = false;
};

// One active runtime of this project with a running agent, and its recent journal.
const http = vi.fn(async (path: string) => {
  if (path === '/api/sessions')
    return [
      {
        sessionId: 's1',
        projectRoot: 'C:/project',
        status: 'active',
        pid: 42,
        startedAt: '2026-11-04T10:00:00Z',
        lastHeartbeatAt: '2026-11-04T10:01:00Z',
        agents: [
          {
            id: 'a1',
            name: 'builder',
            status: 'running',
            currentTool: 'bash',
            iterations: 3,
            toolCalls: 5,
          },
        ],
      },
    ];
  if (path.includes('/events'))
    return {
      sessionId: 's1',
      total: 1,
      truncated: false,
      entries: [
        { role: 'tool', tool: 'bash', text: 'exit 1', ts: '2026-11-04T10:01:00Z', isError: true },
      ],
    };
  return {};
});

/**
 * Opens the runtime list, selects the agent, reads its session activity, opens the broadcast
 * form and the instruction review, then reads the page's text and accessible names.
 */
async function mount() {
  const host = document.createElement('div');
  document.body.append(host);
  let root: Root | undefined;
  await act(async () => {
    root = createRoot(host);
    root.render(
      createElement(ProjectLiveFleet, {
        http,
        projectRoot: 'C:/project',
        carrierId: 'carrier',
        nativeSessions: [],
      }),
    );
  });
  await act(async () => {});
  for (const selector of [
    '.live-fleet-toolbar .feature-actions button:nth-child(2)',
    '.live-fleet-list article > button',
    '.live-fleet-activity header button',
    '.fleet-broadcast > button',
    '.live-fleet-inspector .feature-actions button',
  ]) {
    await act(async () => {
      (host.querySelector(selector) as HTMLElement | null)?.click();
    });
    await act(async () => {});
  }
  const text = host.textContent ?? '';
  const labels = [...host.querySelectorAll('[aria-label]')].map((node) =>
    node.getAttribute('aria-label'),
  );
  act(() => root?.unmount());
  host.remove();
  return { text, labels };
}

describe('project live fleet in the display language', () => {
  afterAll(() => surfaceI18n.changeLanguage('en'));

  it('shows the runtimes, an agent, its activity and a request review in English, then in Turkish', async () => {
    await surfaceI18n.changeLanguage('en');
    let page = await mount();
    for (const text of [
      'PROJECT EXECUTION',
      'Refresh live fleet',
      '1 runtime',
      '1 registered agent',
      'Registry refreshes every 3 seconds',
      'Execution map',
      'Active · PID 42',
      'Running · bash',
      '3 iterations · 5 tool calls',
      'Core session',
      'Last heartbeat',
      'Iterations / tools',
      'Request session interruption',
      'Recent session activity',
      'Showing the most recent entry · 1 recorded entry.',
      'Tool · bash',
      'Reported failure',
      'Message to every live runtime in this project',
      'Send to all',
      'Send instruction to this session?',
      'Delivery kind',
      'steer',
      'Subject (optional)',
      'Keep reviewing fleet',
      'Confirm session request',
    ])
      expect(page.text).toContain(text);
    expect(page.labels).toEqual(
      expect.arrayContaining([
        'Project live fleet',
        'Search live fleet',
        'Live fleet detail',
        'Recent fleet session activity',
        'Fleet instruction kind',
        'Fleet request text',
      ]),
    );

    await surfaceI18n.changeLanguage('tr');
    page = await mount();
    for (const text of [
      'PROJE YÜRÜTMESİ',
      'Canlı filoyu yenile',
      '1 çalışma zamanı',
      '1 kayıtlı ajan',
      'Kayıt defteri 3 saniyede bir yenilenir',
      'Yürütme haritası',
      'Etkin · PID 42',
      'Çalışıyor · bash',
      '3 yineleme · 5 araç çağrısı',
      'Çekirdek oturum',
      'Son sinyal',
      'Yinelemeler / araçlar',
      'Oturumun kesilmesini iste',
      'Son oturum etkinliği',
      'En son kayıt gösteriliyor · 1 kayıtlı giriş.',
      'Araç · bash',
      'Bildirilen hata',
      'Bu projedeki her canlı çalışma zamanına ileti',
      'Hepsine gönder',
      'Bu oturuma talimat gönderilsin mi?',
      'Teslim türü',
      'yönlendir',
      'Konu (isteğe bağlı)',
      'Filoyu incelemeye devam et',
      'Oturum isteğini onayla',
    ])
      expect(page.text).toContain(text);
    expect(page.labels).toEqual(
      expect.arrayContaining([
        'Proje canlı filosu',
        'Canlı filoda ara',
        'Canlı filo ayrıntısı',
        'Son filo oturumu etkinliği',
        'Filo talimatı türü',
        'Filo isteği metni',
      ]),
    );
  });
});
