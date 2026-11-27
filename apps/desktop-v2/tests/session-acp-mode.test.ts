// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { EngineCommand } from '../src/engine-operations';
import { emptyEngineState, reduceEngine } from '../src/engine-state';
import { EngineWorkspace } from '../src/EngineWorkspace';
import { SessionModelControls } from '../src/SessionModelControls';

const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean | undefined };
let workspaceState = emptyEngineState;
const workspaceSend = vi.fn(async () => {});
const workspaceCommand: EngineCommand = async () => ({});
vi.mock('../src/useEngine', () => ({
  useEngine: () => ({ state: workspaceState, send: workspaceSend, command: workspaceCommand }),
}));

it('exposes the live Claude permission mode without opening model and effort settings', async () => {
  const prior = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const command = vi.fn(async (type: string, payload: Record<string, unknown> = {}) => {
    if (type !== 'acp.mode') throw new Error(`Unexpected engine command ${type}`);
    return {
      ok: true,
      modes: [
        {
          id: 'mode',
          name: 'Permission mode',
          currentValue: payload['value'] ?? 'default',
          options: [
            { value: 'default', name: 'Manual' },
            { value: 'bypassPermissions', name: 'Bypass permissions' },
          ],
          selectableValues: ['default', 'bypassPermissions'],
        },
      ],
    };
  });
  try {
    await act(async () =>
      root.render(
        createElement(SessionModelControls, {
          state: {
            ...emptyEngineState,
            connected: true,
            provider: 'acp',
            model: 'claude-code',
            sessionId: 'claude-session',
          },
          command: command as EngineCommand,
          send: async () => {},
          onSettings: () => {},
        }),
      ),
    );
    expect(host.querySelector('details')?.open).toBe(false);
    const selector = host.querySelector<HTMLSelectElement>(
      'select[aria-label="ACP Permission mode"]',
    );
    expect(selector).not.toBeNull();
    expect(selector?.closest('details')).toBeNull();
    expect(selector?.selectedOptions[0]?.textContent).toBe('Manual');
    await act(async () => {
      selector!.value = 'bypassPermissions';
      selector!.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(command).toHaveBeenLastCalledWith(
      'acp.mode',
      {
        agentId: 'claude-code',
        sessionId: 'claude-session',
        optionId: 'mode',
        value: 'bypassPermissions',
      },
      ['acp.mode'],
      { timeoutMs: 100_000 },
    );
    expect(selector?.selectedOptions[0]?.textContent).toBe('Bypass permissions');
  } finally {
    await act(async () => root.unmount());
    host.remove();
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = prior;
  }
});

it('keeps a session-scoped ACP permission action beside the composer even on an empty transcript', async () => {
  const prior = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const scrollTo = Element.prototype.scrollTo;
  const scrollIntoView = Element.prototype.scrollIntoView;
  Element.prototype.scrollTo = () => {};
  Element.prototype.scrollIntoView = () => {};
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  workspaceSend.mockClear();
  workspaceState = reduceEngine(
    {
      ...emptyEngineState,
      connected: true,
      synced: true,
      sessionId: 'claude-session',
      provider: 'acp',
      model: 'claude-code',
    },
    {
      type: 'tool.confirm_needed',
      payload: {
        sessionId: 'claude-session',
        id: 'claude-tool',
        toolName: 'read',
        input: { path: 'fixture.txt' },
      },
    },
  );
  try {
    await act(async () =>
      root.render(
        createElement(EngineWorkspace, {
          id: 'desktop-tab',
          sessionTitle: 'Claude Code',
          scopeKey: 'scope',
          projectId: '',
          projectRoot: '',
          draft: '',
          mode: 'queue',
          onModeChange: () => {},
          draftConflict: false,
          validateDraft: async () => true,
          onDraftChange: async () => true,
          references: [],
          attachments: [],
          onAttachmentsChange: async () => true,
          onReferencesChange: async () => true,
          inputDrafts: {},
          onInputDraftChange: () => {},
          onSettings: () => {},
          onOpen: () => {},
          onError: () => {},
        }),
      ),
    );
    const allow = [
      ...host.querySelectorAll<HTMLButtonElement>('.session-approval-queue button'),
    ].find((button) => button.textContent?.includes('Allow once'));
    expect(allow).toBeDefined();
    expect(allow?.closest('.native-chat-messages')).toBeNull();
    await act(async () => allow!.click());
    expect(workspaceSend).toHaveBeenCalledWith('tool.confirm_result', {
      id: 'claude-tool',
      decision: 'yes',
    });
  } finally {
    await act(async () => root.unmount());
    host.remove();
    Element.prototype.scrollTo = scrollTo;
    Element.prototype.scrollIntoView = scrollIntoView;
    vi.unstubAllGlobals();
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = prior;
  }
});
