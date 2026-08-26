/**
 * PR 0 of Issue #31 — Baseline dispatcher-routing test.
 *
 * Locks down the chain-of-responsibility contract for the WebUI WS message
 * dispatcher: each sibling route handler owns a set of message-type prefixes
 * and returns `true` when it handled a message, `false` otherwise. The
 * central `handleMessage` switch in `index.ts` walks the chain in order and
 * stops at the first `true`.
 *
 * This test does NOT spin up a real WebSocket server — it imports each
 * sibling `handleXxxRoute` directly and exercises its prefix claim. That
 * pins the most important architectural invariant for the rest of #31:
 * when a refactor PR moves a `case` from one sibling to another, this
 * test will catch it.
 *
 * Each handler gets two tests:
 *   - `claims <prefix>.*`  — sends a message the handler SHOULD own, asserts
 *                          the resolved `true` and that the right nested
 *                          handler stub was invoked.
 *   - `returns false for foreign message type` — sends `test.unknown`, which
 *                          no sibling claims; asserts `false` so the chain
 *                          falls through.
 *
 * Handlers are imported directly from their module files (not from
 * `index.ts` which only uses them internally). That keeps the test
 * surface independent of the central dispatcher file.
 */

import type { WSClientMessage } from '@wrongstack/webui-server';
import {
  handleBrainRoute,
  handleGoalRoute,
  handleMailboxRoute,
  handleMcpRoute,
  handleModeRoute,
  handlePrefsRoute,
  handleProjectRoute,
  handleProviderRoute,
  handleSddBoardRoute,
  handleSddWizardRoute,
  handleSessionRoute,
  handleShellGitRoute,
  handleSpecsRoute,
} from '@wrongstack/webui-server';
import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';

/** ws stub — no real socket needed; we only assert resolved return values. */
function fakeWs(): WebSocket {
  return { readyState: 1, send: vi.fn(), on: vi.fn() } as unknown as WebSocket;
}

/** Foreign message type that no sibling route handler claims (sanity probe). */
const FOREIGN = 'test.unknown' as WSClientMessage['type'];

const ws = fakeWs();

describe('WS message dispatcher routing (Issue #31 PR 0)', () => {
  // ── ProviderRouteHandlers ──────────────────────────────────────────
  it('handleProviderRoute: claims providers.list; rejects foreign', async () => {
    const listProviders = vi.fn();
    const out = await handleProviderRoute(ws, { type: 'providers.list' }, {
      listProviders,
      listSavedProviders: vi.fn(),
      listProviderModels: vi.fn(),
      switchModel: vi.fn(),
      refineModel: vi.fn(),
      providerHandlers: { handleKeyUpsert: vi.fn(), handleKeyDelete: vi.fn() },
    } as never);
    expect(out).toBe(true);
    expect(listProviders).toHaveBeenCalledOnce();
  });

  it('handleProviderRoute: returns false for foreign message type', async () => {
    const out = await handleProviderRoute(ws, { type: FOREIGN }, {
      listProviders: vi.fn(),
      listSavedProviders: vi.fn(),
      listProviderModels: vi.fn(),
      switchModel: vi.fn(),
      refineModel: vi.fn(),
      providerHandlers: { handleKeyUpsert: vi.fn(), handleKeyDelete: vi.fn() },
    } as never);
    expect(out).toBe(false);
  });

  // ── SessionRouteHandlers ───────────────────────────────────────────
  it('handleSessionRoute: claims session.new; rejects foreign', async () => {
    const newSession = vi.fn();
    const out = await handleSessionRoute(ws, { type: 'session.new' }, {
      newSession,
      clearContext: vi.fn(),
      debugContext: vi.fn(),
      compactContext: vi.fn(),
      repairContext: vi.fn(),
      openContextEditor: vi.fn(),
      validateContextEditor: vi.fn(),
      applyContextEditor: vi.fn(),
      listContextModes: vi.fn(),
      switchContextMode: vi.fn(),
      createContextMode: vi.fn(),
      updateContextMode: vi.fn(),
      deleteContextMode: vi.fn(),
      listSessions: vi.fn(),
      deleteSession: vi.fn(),
      resumeSession: vi.fn(),
      saveSession: vi.fn(),
      listCheckpoints: vi.fn(),
      rewindSession: vi.fn(),
    } as never);
    expect(out).toBe(true);
    expect(newSession).toHaveBeenCalledOnce();
  });

  it('handleSessionRoute: returns false for foreign message type', async () => {
    const out = await handleSessionRoute(ws, { type: FOREIGN }, {
      newSession: vi.fn(),
      clearContext: vi.fn(),
      debugContext: vi.fn(),
      compactContext: vi.fn(),
      repairContext: vi.fn(),
      openContextEditor: vi.fn(),
      validateContextEditor: vi.fn(),
      applyContextEditor: vi.fn(),
      listContextModes: vi.fn(),
      switchContextMode: vi.fn(),
      createContextMode: vi.fn(),
      updateContextMode: vi.fn(),
      deleteContextMode: vi.fn(),
      listSessions: vi.fn(),
      deleteSession: vi.fn(),
      resumeSession: vi.fn(),
      saveSession: vi.fn(),
      listCheckpoints: vi.fn(),
      rewindSession: vi.fn(),
    } as never);
    expect(out).toBe(false);
  });

  // ── ProjectRouteHandlers ───────────────────────────────────────────
  it('handleProjectRoute: claims projects.list; rejects foreign', async () => {
    const listProjects = vi.fn();
    const out = await handleProjectRoute(ws, { type: 'projects.list' }, {
      listProjects,
      addProject: vi.fn(),
      selectProject: vi.fn(),
      setWorkingDir: vi.fn(),
    } as never);
    expect(out).toBe(true);
    expect(listProjects).toHaveBeenCalledOnce();
  });

  it('handleProjectRoute: returns false for foreign message type', async () => {
    const out = await handleProjectRoute(ws, { type: FOREIGN }, {
      listProjects: vi.fn(),
      addProject: vi.fn(),
      selectProject: vi.fn(),
      setWorkingDir: vi.fn(),
    } as never);
    expect(out).toBe(false);
  });

  // ── ModeRouteHandlers ──────────────────────────────────────────────
  it('handleModeRoute: claims modes.list; rejects foreign', async () => {
    const listModes = vi.fn();
    const out = await handleModeRoute(ws, { type: 'modes.list' }, {
      listModes,
      switchMode: vi.fn(),
    } as never);
    expect(out).toBe(true);
    expect(listModes).toHaveBeenCalledOnce();
  });

  it('handleModeRoute: returns false for foreign message type', async () => {
    const out = await handleModeRoute(ws, { type: FOREIGN }, {
      listModes: vi.fn(),
      switchMode: vi.fn(),
    } as never);
    expect(out).toBe(false);
  });

  // ── PrefsRouteHandlers ─────────────────────────────────────────────
  // Issue #31 follow-on (extracted from index.ts as the 12th sibling).
  // Two callbacks only — `getPrefs` and `updatePrefs` — because the
  // standalone server's pref logic is rich enough that bundling 10+
  // closure-captured dependencies into a single PrefsContext would
  // duplicate state already living on index.ts.
  it('handlePrefsRoute: claims prefs.get; rejects foreign', async () => {
    const getPrefs = vi.fn();
    const out = await handlePrefsRoute(ws, { type: 'prefs.get' }, {
      getPrefs,
      updatePrefs: vi.fn(),
    } as never);
    expect(out).toBe(true);
    expect(getPrefs).toHaveBeenCalledOnce();
  });

  it('handlePrefsRoute: claims prefs.update; rejects foreign', async () => {
    const updatePrefs = vi.fn();
    const out = await handlePrefsRoute(ws, { type: 'prefs.update', payload: { yolo: true } }, {
      getPrefs: vi.fn(),
      updatePrefs,
    } as never);
    expect(out).toBe(true);
    expect(updatePrefs).toHaveBeenCalledOnce();
    expect(updatePrefs).toHaveBeenCalledWith(ws, { yolo: true });
  });

  it('handlePrefsRoute: routes config.doctor with the apply flag', async () => {
    const doctorConfig = vi.fn();
    const out = await handlePrefsRoute(
      ws,
      { type: 'config.doctor', payload: { apply: true } },
      { getPrefs: vi.fn(), updatePrefs: vi.fn(), getSystemPrompt: vi.fn(), doctorConfig },
    );
    expect(out).toBe(true);
    expect(doctorConfig).toHaveBeenCalledWith(ws, true);
  });

  it('handlePrefsRoute: returns false for foreign message type', async () => {
    const out = await handlePrefsRoute(ws, { type: FOREIGN }, {
      getPrefs: vi.fn(),
      updatePrefs: vi.fn(),
    } as never);
    expect(out).toBe(false);
  });

  // ── ShellGitRouteHandlers ──────────────────────────────────────────
  it('handleShellGitRoute: claims git.info; rejects foreign', async () => {
    const gitInfo = vi.fn();
    const out = await handleShellGitRoute(ws, { type: 'git.info' }, {
      gitInfo,
      gitChanges: vi.fn(),
      gitDiff: vi.fn(),
      shellOpen: vi.fn(),
    } as never);
    expect(out).toBe(true);
    expect(gitInfo).toHaveBeenCalledOnce();
  });

  it('handleShellGitRoute: returns false for foreign message type', async () => {
    const out = await handleShellGitRoute(ws, { type: FOREIGN }, {
      gitInfo: vi.fn(),
      gitChanges: vi.fn(),
      gitDiff: vi.fn(),
      shellOpen: vi.fn(),
    } as never);
    expect(out).toBe(false);
  });

  // ── MailboxRouteHandlers ───────────────────────────────────────────
  it('handleMailboxRoute: claims mailbox.messages; rejects foreign', async () => {
    const messages = vi.fn();
    const out = await handleMailboxRoute(ws, { type: 'mailbox.messages' }, {
      messages,
      agents: vi.fn(),
      clear: vi.fn(),
      purge: vi.fn(),
    } as never);
    expect(out).toBe(true);
    expect(messages).toHaveBeenCalledOnce();
  });

  it('handleMailboxRoute: returns false for foreign message type', async () => {
    const out = await handleMailboxRoute(ws, { type: FOREIGN }, {
      messages: vi.fn(),
      agents: vi.fn(),
      clear: vi.fn(),
      purge: vi.fn(),
    } as never);
    expect(out).toBe(false);
  });

  // ── McpRouteHandlers ──────────────────────────────────────────────
  // Issue #31 follow-on (after PR #118 baseline, #119 prefs extraction).
  // The 10 mcp.* callbacks delegate to handleMcpXxx in mcp-handlers.ts;
  // this test pins the chain-of-responsibility contract for the new 13th
  // sibling.
  const mcpHandlersStub = () => ({
    list: vi.fn(),
    add: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    enable: vi.fn(),
    disable: vi.fn(),
    sleep: vi.fn(),
    wake: vi.fn(),
    restart: vi.fn(),
    discover: vi.fn(),
    resources: vi.fn(),
    prompts: vi.fn(),
    resourceRead: vi.fn(),
    promptGet: vi.fn(),
  });

  it('handleMcpRoute: claims mcp.list; rejects foreign', async () => {
    const h = mcpHandlersStub();
    const out = await handleMcpRoute(ws, { type: 'mcp.list' }, h as never);
    expect(out).toBe(true);
    expect(h.list).toHaveBeenCalledOnce();
  });

  it('handleMcpRoute: claims mcp.restart; rejects foreign', async () => {
    const h = mcpHandlersStub();
    const out = await handleMcpRoute(
      ws,
      { type: 'mcp.restart', payload: { name: 'foo' } },
      h as never,
    );
    expect(out).toBe(true);
    expect(h.restart).toHaveBeenCalledOnce();
    expect(h.restart).toHaveBeenCalledWith(ws, { type: 'mcp.restart', payload: { name: 'foo' } });
  });

  it('handleMcpRoute: returns false for foreign message type', async () => {
    const h = mcpHandlersStub();
    const out = await handleMcpRoute(ws, { type: FOREIGN }, h as never);
    expect(out).toBe(false);
  });

  it.each([
    ['mcp.resources', 'resources'],
    ['mcp.prompts', 'prompts'],
    ['mcp.resource.read', 'resourceRead'],
    ['mcp.prompt.get', 'promptGet'],
  ] as const)('handleMcpRoute: claims %s', async (type, handler) => {
    const h = mcpHandlersStub();
    const out = await handleMcpRoute(ws, { type }, h as never);
    expect(out).toBe(true);
    expect(h[handler]).toHaveBeenCalledOnce();
  });

  // ── BrainRouteHandlers ─────────────────────────────────────────────
  it('handleBrainRoute: claims brain.status; rejects foreign', async () => {
    const status = vi.fn();
    const out = await handleBrainRoute(ws, { type: 'brain.status' }, {
      status,
      risk: vi.fn(),
      ask: vi.fn(),
    } as never);
    expect(out).toBe(true);
    expect(status).toHaveBeenCalledOnce();
  });

  it('handleBrainRoute: returns false for foreign message type', async () => {
    const out = await handleBrainRoute(ws, { type: FOREIGN }, {
      status: vi.fn(),
      risk: vi.fn(),
      ask: vi.fn(),
    } as never);
    expect(out).toBe(false);
  });

  // ── GoalRouteHandlers ─────────────────────────────────────────────
  it('handleGoalRoute: claims goal.* (prefix gate); rejects foreign', async () => {
    const handleMessage = vi.fn();
    const out = await handleGoalRoute(ws, { type: 'goal.tick' }, {
      handleMessage,
    } as never);
    expect(out).toBe(true);
    expect(handleMessage).toHaveBeenCalledOnce();
  });

  it('handleGoalRoute: returns false for foreign message type', async () => {
    const handleMessage = vi.fn();
    const out = await handleGoalRoute(ws, { type: FOREIGN }, {
      handleMessage,
    } as never);
    expect(out).toBe(false);
    expect(handleMessage).not.toHaveBeenCalled();
  });

  // ── SpecsRouteHandlers ─────────────────────────────────────────────
  it('handleSpecsRoute: claims specs.* (prefix gate); rejects foreign', async () => {
    const handleMessage = vi.fn();
    const out = await handleSpecsRoute(ws, { type: 'specs.list' }, {
      handleMessage,
    } as never);
    expect(out).toBe(true);
    expect(handleMessage).toHaveBeenCalledOnce();
  });

  it('handleSpecsRoute: returns false for foreign message type', async () => {
    const handleMessage = vi.fn();
    const out = await handleSpecsRoute(ws, { type: FOREIGN }, {
      handleMessage,
    } as never);
    expect(out).toBe(false);
    expect(handleMessage).not.toHaveBeenCalled();
  });

  // ── SddBoardRouteHandlers ──────────────────────────────────────────
  it('handleSddBoardRoute: claims sdd.board.* (prefix gate); rejects foreign', async () => {
    const handleMessage = vi.fn();
    const out = await handleSddBoardRoute(ws, { type: 'sdd.board.focus' }, {
      handleMessage,
    } as never);
    expect(out).toBe(true);
    expect(handleMessage).toHaveBeenCalledOnce();
  });

  it('handleSddBoardRoute: returns false for foreign message type', async () => {
    const handleMessage = vi.fn();
    const out = await handleSddBoardRoute(ws, { type: FOREIGN }, {
      handleMessage,
    } as never);
    expect(out).toBe(false);
    expect(handleMessage).not.toHaveBeenCalled();
  });

  // ── SddWizardRouteHandlers ─────────────────────────────────────────
  it('handleSddWizardRoute: claims sdd.spec.* (prefix gate); rejects foreign', async () => {
    const handleMessage = vi.fn();
    const out = await handleSddWizardRoute(ws, { type: 'sdd.spec.create' }, {
      handleMessage,
    } as never);
    expect(out).toBe(true);
    expect(handleMessage).toHaveBeenCalledOnce();
  });

  it('handleSddWizardRoute: returns false for foreign message type', async () => {
    const handleMessage = vi.fn();
    const out = await handleSddWizardRoute(ws, { type: FOREIGN }, {
      handleMessage,
    } as never);
    expect(out).toBe(false);
    expect(handleMessage).not.toHaveBeenCalled();
  });
});
