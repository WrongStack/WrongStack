/**
 * @vitest-environment jsdom
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DesktopSessionBranchAndPlugins } from '../src/DesktopSessionBranchAndPlugins.js';

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function showModal() {
      this.setAttribute('open', '');
    };
  }
  if (!HTMLDialogElement.prototype.close) {
    HTMLDialogElement.prototype.close = function close() {
      this.removeAttribute('open');
    };
  }
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
  }
  container?.remove();
  root = null;
  container = null;
});

describe('DesktopSessionBranchAndPlugins catch and session guard', () => {
  it('captures malformed JSON in triggerAction into panelError and ignores stale session responses', async () => {
    let resolveSlowAction!: (val: unknown) => void;
    const command = async (_type: string, payload?: { args?: string }) => {
      const args = payload?.args ?? '';
      if (args.startsWith('list')) {
        return {
          message: JSON.stringify({
            statusChips: [],
            panels: [{ qualifiedId: 'p1', owner: 'demo', title: 'Demo Panel' }],
          }),
        };
      }
      if (args.startsWith('show')) {
        return {
          message: JSON.stringify({
            activePanel: {
              qualifiedId: 'p1',
              title: 'Demo Panel',
              view: { kind: 'text', text: 'Demo body' },
              actions: [
                { id: 'badJson', label: 'Bad JSON' },
                { id: 'slowAct', label: 'Slow Act' },
              ],
            },
          }),
        };
      }
      if (args.includes('badJson')) {
        return { message: 'NOT_JSON_RESPONSE' };
      }
      if (args.includes('slowAct')) {
        return new Promise((resolve) => {
          resolveSlowAction = resolve;
        });
      }
      return {};
    };

    const state1 = { connected: true, sessionId: 'sess-1', messages: [], results: {} } as never;
    await act(async () => {
      root!.render(
        <DesktopSessionBranchAndPlugins
          state={state1}
          command={command as never}
          refresh={() => {}}
        />,
      );
    });

    const openPanelBtn = container!.querySelector('button');
    await act(async () => {
      openPanelBtn!.click();
    });

    const badBtn = Array.from(document.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Bad JSON'),
    );
    await act(async () => {
      badBtn!.click();
    });
    expect(document.body.textContent).toContain('JSON');

    const slowBtn = Array.from(document.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Slow Act'),
    );
    await act(async () => {
      slowBtn!.click();
    });

    const state2 = { connected: true, sessionId: 'sess-2', messages: [], results: {} } as never;
    await act(async () => {
      root!.render(
        <DesktopSessionBranchAndPlugins
          state={state2}
          command={command as never}
          refresh={() => {}}
        />,
      );
    });

    await act(async () => {
      resolveSlowAction({
        message: JSON.stringify({
          activePanel: {
            qualifiedId: 'p1',
            title: 'Stale Session Panel',
            view: { kind: 'text', text: 'Stale' },
            actions: [],
          },
        }),
      });
    });

    expect(document.body.textContent).not.toContain('Stale Session Panel');
  });
});
