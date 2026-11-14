import type { PluginPanelAction, PluginViewNode } from '@wrongstack/contracts/types/plugin';
import type { SessionTreeSnapshot } from '@wrongstack/contracts/types/session';
import {
  type PluginStatusChipItem,
  PluginStatusChipsBar,
  PluginViewNodeRenderer,
} from '@wrongstack/project-surfaces/plugin-ui';
import { SessionBranchPill } from '@wrongstack/project-surfaces/session-tree';
import { Blocks, RefreshCw, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { runEngineText } from './engine-command-run';
import type { EngineCommand } from './engine-operations';
import type { EngineState } from './engine-state';
import { Modal } from './Modal';
import './surfaces.css';

interface PluginPanelSummary {
  qualifiedId: string;
  owner: string;
  id: string;
  title: string;
  actions: readonly PluginPanelAction[];
}

interface ActivePluginPanel extends PluginPanelSummary {
  view: PluginViewNode;
}

interface PluginUiCatalogPayload {
  statusChips?: PluginStatusChipItem[];
  panels?: PluginPanelSummary[];
  activePanel?: ActivePluginPanel;
  error?: string;
}

interface PendingDesktopPluginPrompt {
  requestId: string;
  owner: string;
  kind: 'select' | 'confirm' | 'input';
  title: string;
  message?: string | undefined;
  options?: Array<{ value: string; label: string; hint?: string | undefined }> | undefined;
}

function quoteTreeArg(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function parseTreeSnapshot(raw: string): SessionTreeSnapshot | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SessionTreeSnapshot>;
    if (
      parsed &&
      typeof parsed.activeBranchId === 'string' &&
      parsed.branches &&
      typeof parsed.branches === 'object'
    ) {
      return {
        activeBranchId: parsed.activeBranchId,
        branches: parsed.branches,
        headSeq: typeof parsed.headSeq === 'number' ? parsed.headSeq : -1,
      };
    }
  } catch {
    // Non-JSON responses occur when no session tree exists yet.
  }
  return null;
}

/**
 * Desktop status-bar controls for intra-session CAS branches (`/tree`) and
 * live plugin UI slots (`api.ui` status chips, `/panel` modal, toasts, and prompts).
 */
export function DesktopSessionBranchAndPlugins({
  state,
  command,
  refresh,
}: {
  state: EngineState;
  command: EngineCommand;
  refresh: () => void;
}) {
  const [tree, setTree] = useState<SessionTreeSnapshot | null>(null);
  const [treeBusy, setTreeBusy] = useState(false);

  const [chips, setChips] = useState<PluginStatusChipItem[]>([]);
  const [panels, setPanels] = useState<PluginPanelSummary[]>([]);
  const [panelOpen, setPanelOpen] = useState(false);
  const [selectedPanelId, setSelectedPanelId] = useState<string | null>(null);
  const [activePanel, setActivePanel] = useState<ActivePluginPanel | null>(null);
  const [panelBusy, setPanelBusy] = useState(false);
  const [panelError, setPanelError] = useState('');
  const [toastBanner, setToastBanner] = useState<string>('');

  const [pendingPrompt, setPendingPrompt] = useState<PendingDesktopPluginPrompt | null>(null);
  const [promptInput, setPromptInput] = useState('');
  const lastSeenPromptId = useRef<string>('');
  const lastSeenNotifyRef = useRef<unknown>(null);

  const refreshTree = useCallback(async () => {
    if (!state.connected || !state.sessionId) {
      setTree(null);
      return;
    }
    const res = await runEngineText(command, 'tree', 'list --json', state.sessionId);
    if (res.error || !res.text) return;
    const next = parseTreeSnapshot(res.text);
    if (next) setTree(next);
  }, [command, state.connected, state.sessionId]);

  const loadPluginCatalog = useCallback(async () => {
    if (!state.connected) return;
    const res = await runEngineText(command, 'panel', 'list --json', state.sessionId || undefined);
    if (res.error || !res.text) return;
    try {
      const parsed = JSON.parse(res.text) as PluginUiCatalogPayload;
      if (Array.isArray(parsed.statusChips)) setChips(parsed.statusChips);
      if (Array.isArray(parsed.panels)) setPanels(parsed.panels);
    } catch {
      // Ignore non-JSON responses.
    }
  }, [command, state.connected, state.sessionId]);

  const loadPanelDetail = useCallback(
    async (panelRef: string) => {
      if (!state.connected) return;
      setPanelBusy(true);
      setPanelError('');
      try {
        const res = await runEngineText(
          command,
          'panel',
          `show ${panelRef} --json`,
          state.sessionId || undefined,
        );
        if (res.error) {
          setPanelError(res.error);
          return;
        }
        if (!res.text) return;
        const parsed = JSON.parse(res.text) as PluginUiCatalogPayload;
        if (parsed.error) {
          setPanelError(parsed.error);
          return;
        }
        if (Array.isArray(parsed.statusChips)) setChips(parsed.statusChips);
        if (Array.isArray(parsed.panels)) setPanels(parsed.panels);
        if (parsed.activePanel) {
          setActivePanel(parsed.activePanel);
          setSelectedPanelId(parsed.activePanel.qualifiedId);
        }
      } catch (err) {
        setPanelError(err instanceof Error ? err.message : String(err));
      } finally {
        setPanelBusy(false);
      }
    },
    [command, state.connected, state.sessionId],
  );

  useEffect(() => {
    void refreshTree();
  }, [refreshTree, state.messages.length]);

  useEffect(() => {
    if (state.connected) void loadPluginCatalog();
  }, [state.connected, loadPluginCatalog]);

  const pluginUpdatedFrame = state.results['plugin.ui.updated'];
  useEffect(() => {
    if (!pluginUpdatedFrame) return;
    const nextChips = pluginUpdatedFrame['statusChips'];
    if (Array.isArray(nextChips)) {
      setChips(nextChips as PluginStatusChipItem[]);
    }
    if (panelOpen && selectedPanelId) {
      void loadPanelDetail(selectedPanelId);
    } else {
      void loadPluginCatalog();
    }
  }, [pluginUpdatedFrame, panelOpen, selectedPanelId, loadPanelDetail, loadPluginCatalog]);

  const pluginNotifyFrame = state.results['plugin.ui.notify'];
  useEffect(() => {
    if (!pluginNotifyFrame || pluginNotifyFrame === lastSeenNotifyRef.current) return;
    lastSeenNotifyRef.current = pluginNotifyFrame;
    const owner = typeof pluginNotifyFrame['owner'] === 'string' ? pluginNotifyFrame['owner'] : '';
    const msg =
      typeof pluginNotifyFrame['message'] === 'string' ? pluginNotifyFrame['message'] : '';
    if (!msg) return;
    setToastBanner(owner ? `[${owner}] ${msg}` : msg);
    const timer = setTimeout(() => setToastBanner(''), 4_000);
    return () => clearTimeout(timer);
  }, [pluginNotifyFrame]);

  const pluginPromptFrame = state.results['plugin.ui.prompt'];
  useEffect(() => {
    if (!pluginPromptFrame) return;
    const reqId =
      typeof pluginPromptFrame['promptId'] === 'string'
        ? pluginPromptFrame['promptId']
        : typeof pluginPromptFrame['requestId'] === 'string'
          ? pluginPromptFrame['requestId']
          : '';
    if (!reqId || reqId === lastSeenPromptId.current) return;
    const kind = pluginPromptFrame['kind'];
    if (kind !== 'select' && kind !== 'confirm' && kind !== 'input') return;
    lastSeenPromptId.current = reqId;
    setPromptInput('');
    setPendingPrompt({
      requestId: reqId,
      owner: typeof pluginPromptFrame['owner'] === 'string' ? pluginPromptFrame['owner'] : 'plugin',
      kind,
      title: typeof pluginPromptFrame['title'] === 'string' ? pluginPromptFrame['title'] : 'Prompt',
      message:
        typeof pluginPromptFrame['message'] === 'string' ? pluginPromptFrame['message'] : undefined,
      options: Array.isArray(pluginPromptFrame['options'])
        ? (pluginPromptFrame['options'] as PendingDesktopPluginPrompt['options'])
        : undefined,
    });
  }, [pluginPromptFrame]);

  const pluginPromptResolvedFrame = state.results['plugin.ui.prompt_resolved'];
  useEffect(() => {
    if (!pluginPromptResolvedFrame) return;
    const resolvedId =
      typeof pluginPromptResolvedFrame['promptId'] === 'string'
        ? pluginPromptResolvedFrame['promptId']
        : typeof pluginPromptResolvedFrame['requestId'] === 'string'
          ? pluginPromptResolvedFrame['requestId']
          : '';
    if (!resolvedId) return;
    setPendingPrompt((prev) => (prev?.requestId === resolvedId ? null : prev));
  }, [pluginPromptResolvedFrame]);

  const submitPrompt = useCallback(
    (value: string | boolean | null) => {
      if (!pendingPrompt) return;
      const promptId = pendingPrompt.requestId;
      setPendingPrompt(null);
      void command(
        'plugin.ui.prompt_response',
        { promptId, value },
        ['plugin.ui.prompt_resolved'],
        { timeoutMs: 5_000 },
      ).catch(() => {
        // Prompt already timed out or resolved upstream.
      });
    },
    [command, pendingPrompt],
  );

  const runTreeMutation = useCallback(
    async (subcommandArgs: string) => {
      if (!state.connected || !state.sessionId || state.running) return;
      setTreeBusy(true);
      try {
        const res = await runEngineText(command, 'tree', subcommandArgs, state.sessionId);
        if (!res.error) {
          await refreshTree();
          refresh();
        }
      } finally {
        setTreeBusy(false);
      }
    },
    [command, refresh, refreshTree, state.connected, state.running, state.sessionId],
  );

  const openModalForPanel = useCallback(
    (requestedId?: string) => {
      setPanelOpen(true);
      const target =
        (requestedId
          ? panels.find((p) => p.qualifiedId === requestedId || p.id === requestedId)?.qualifiedId
          : undefined) ??
        selectedPanelId ??
        panels[0]?.qualifiedId ??
        null;
      if (target) {
        void loadPanelDetail(target);
      }
    },
    [loadPanelDetail, panels, selectedPanelId],
  );

  const triggerAction = useCallback(
    async (panelId: string, actionId: string) => {
      setPanelBusy(true);
      setPanelError('');
      try {
        const res = await runEngineText(
          command,
          'panel',
          `action ${panelId} ${actionId} --json`,
          state.sessionId || undefined,
        );
        if (res.error) {
          setPanelError(res.error);
          return;
        }
        if (!res.text) return;
        const parsed = JSON.parse(res.text) as PluginUiCatalogPayload;
        if (parsed.error) {
          setPanelError(parsed.error);
          return;
        }
        if (Array.isArray(parsed.statusChips)) setChips(parsed.statusChips);
        if (Array.isArray(parsed.panels)) setPanels(parsed.panels);
        if (parsed.activePanel) setActivePanel(parsed.activePanel);
      } finally {
        setPanelBusy(false);
      }
    },
    [command, state.sessionId],
  );

  return (
    <>
      {/* The pill is a shared WebUI component: its colours come from the surface tokens, which
          apply only inside `.ws-surfaces`. It sits in the status bar at the bottom of the
          window, so its menu opens upwards. */}
      {tree && (
        <span className="ws-surfaces session-branch-slot">
          <SessionBranchPill
            placement="up"
            tree={tree}
            busy={treeBusy || state.running}
            onRefresh={() => void refreshTree()}
            onCreateBranch={(name) => runTreeMutation(`branch ${quoteTreeArg(name)}`)}
            onSwitchBranch={(branchId, opts) =>
              runTreeMutation(
                `switch ${quoteTreeArg(branchId)}${opts?.keepFiles ? ' --keep-files' : ''}`,
              )
            }
            onFoldBranch={(sourceBranchId, opts) =>
              runTreeMutation(
                `fold ${quoteTreeArg(sourceBranchId)}${opts?.note ? ` --note ${quoteTreeArg(opts.note)}` : ''}${opts?.keepOpen ? ' --keep-open' : ''}`,
              )
            }
          />
        </span>
      )}

      {chips.length > 0 && (
        <span className="ws-surfaces session-branch-slot">
          <PluginStatusChipsBar
            chips={chips}
            onSelectChip={(chip) => {
              const ownerPanel = panels.find((p) => p.owner === chip.owner);
              openModalForPanel(ownerPanel?.qualifiedId);
            }}
          />
        </span>
      )}

      {panels.length > 0 && (
        <button
          type="button"
          data-chip="plugins"
          title="Open plugin panels (/panel)"
          onClick={() => openModalForPanel()}
        >
          <Blocks size={11} /> Panels ({panels.length})
        </button>
      )}

      {toastBanner && <span data-chip="plugin-toast">{toastBanner}</span>}

      {panelOpen && (
        <Modal onClose={() => setPanelOpen(false)} title="Plugin Panels">
          <div className="composer-dialog">
            <header>
              <h2>
                <Blocks size={15} /> Plugin Panels
              </h2>
              <button
                type="button"
                aria-label="Close plugin panels"
                onClick={() => setPanelOpen(false)}
              >
                <X size={15} />
              </button>
            </header>
            {panels.length > 1 && (
              <div className="flex flex-wrap gap-1.5 pb-2">
                {panels.map((p) => (
                  <button
                    key={p.qualifiedId}
                    type="button"
                    disabled={panelBusy}
                    onClick={() => void loadPanelDetail(p.qualifiedId)}
                    className={
                      selectedPanelId === p.qualifiedId ? 'primary-button' : 'secondary-button'
                    }
                  >
                    {p.title}
                  </button>
                ))}
              </div>
            )}
            {panelError && <p className="error-banner">{panelError}</p>}
            {activePanel ? (
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <strong>{activePanel.title}</strong>
                  <div className="flex items-center gap-1.5">
                    {activePanel.actions.map((act) => (
                      <button
                        key={act.id}
                        type="button"
                        disabled={panelBusy}
                        onClick={() => void triggerAction(activePanel.qualifiedId, act.id)}
                      >
                        {act.label}
                      </button>
                    ))}
                    <button
                      type="button"
                      disabled={panelBusy}
                      aria-label="Refresh panel"
                      onClick={() => void loadPanelDetail(activePanel.qualifiedId)}
                    >
                      <RefreshCw size={12} />
                    </button>
                  </div>
                </div>
                <PluginViewNodeRenderer node={activePanel.view} />
              </div>
            ) : (
              <p>No active plugin panel selected.</p>
            )}
          </div>
        </Modal>
      )}

      {pendingPrompt && (
        <Modal onClose={() => submitPrompt(null)} title={pendingPrompt.title}>
          <div className="composer-dialog">
            <header>
              <h2>
                [{pendingPrompt.owner}] {pendingPrompt.title}
              </h2>
              <button
                type="button"
                aria-label="Cancel plugin prompt"
                onClick={() => submitPrompt(null)}
              >
                <X size={15} />
              </button>
            </header>
            {pendingPrompt.message && <p>{pendingPrompt.message}</p>}
            {pendingPrompt.kind === 'confirm' && (
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => submitPrompt(false)}>
                  No
                </button>
                <button type="button" onClick={() => submitPrompt(true)}>
                  Yes
                </button>
              </div>
            )}
            {pendingPrompt.kind === 'select' && (
              <div className="space-y-1.5 pt-2">
                {(pendingPrompt.options ?? []).map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    className="w-full text-left"
                    onClick={() => submitPrompt(opt.value)}
                  >
                    <strong>{opt.label}</strong>
                    {opt.hint ? ` — ${opt.hint}` : ''}
                  </button>
                ))}
              </div>
            )}
            {pendingPrompt.kind === 'input' && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  submitPrompt(promptInput);
                }}
                className="space-y-2 pt-2"
              >
                <input
                  type="text"
                  value={promptInput}
                  onChange={(e) => setPromptInput(e.target.value)}
                  className="w-full"
                />
                <div className="flex justify-end gap-2">
                  <button type="button" onClick={() => submitPrompt(null)}>
                    Cancel
                  </button>
                  <button type="submit">Submit</button>
                </div>
              </form>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
