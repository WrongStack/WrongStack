import type { PluginPanelAction, PluginViewNode } from '@wrongstack/contracts/types/plugin';
import {
  type PluginStatusChipItem,
  PluginStatusChipsBar,
  PluginViewNodeRenderer,
} from '@wrongstack/project-surfaces/plugin-ui';
import { Blocks, RefreshCw, X } from 'lucide-react';
import type React from 'react';
import { useCallback, useEffect, useState } from 'react';
import { invokePortableCommand } from '@/lib/portable-command-rpc';
import { getWSClient } from '@/lib/ws-client';
import { useConfigStore } from '@/stores';

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

type ModalOpenListener = (panelId?: string) => void;
const modalOpenListeners = new Set<ModalOpenListener>();

/**
 * Imperatively open the WebUI Plugin UI modal (used by `/panel` slash routing
 * and status chip clicks). Returns true when a mounted listener handled it.
 */
export function openPluginUiModal(panelId?: string): boolean {
  if (modalOpenListeners.size === 0) return false;
  for (const listener of modalOpenListeners) {
    listener(panelId);
  }
  return true;
}

export function PluginUiBarAndModal(): React.ReactElement | null {
  const wsStatus = useConfigStore((s) => s.wsStatus);
  const [chips, setChips] = useState<PluginStatusChipItem[]>([]);
  const [panels, setPanels] = useState<PluginPanelSummary[]>([]);
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activePanel, setActivePanel] = useState<ActivePluginPanel | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadCatalog = useCallback(async () => {
    if (wsStatus.state !== 'open') return;
    const res = await invokePortableCommand('panel', 'list --json', { timeoutMs: 4_000 });
    if (res.error || !res.message) return;
    try {
      const parsed = JSON.parse(res.message) as PluginUiCatalogPayload;
      if (Array.isArray(parsed.statusChips)) setChips(parsed.statusChips);
      if (Array.isArray(parsed.panels)) setPanels(parsed.panels);
    } catch {
      // Ignore non-JSON responses (e.g., older server builds).
    }
  }, [wsStatus.state]);

  const loadPanelDetail = useCallback(
    async (panelRef: string) => {
      if (wsStatus.state !== 'open') return;
      setBusy(true);
      setError(null);
      try {
        const res = await invokePortableCommand('panel', `show ${panelRef} --json`, {
          timeoutMs: 6_000,
        });
        if (res.error) {
          setError(res.error);
          return;
        }
        if (!res.message) return;
        const parsed = JSON.parse(res.message) as PluginUiCatalogPayload;
        if (parsed.error) {
          setError(parsed.error);
          return;
        }
        if (Array.isArray(parsed.statusChips)) setChips(parsed.statusChips);
        if (Array.isArray(parsed.panels)) setPanels(parsed.panels);
        if (parsed.activePanel) {
          setActivePanel(parsed.activePanel);
          setSelectedId(parsed.activePanel.qualifiedId);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [wsStatus.state],
  );

  useEffect(() => {
    if (wsStatus.state === 'open') {
      void loadCatalog();
    }
  }, [wsStatus.state, loadCatalog]);

  useEffect(() => {
    const client = getWSClient();
    const off = client.on('command.result', (msg) => {
      if (msg.payload.name === 'plugin') {
        void loadCatalog();
        if (open && selectedId) {
          void loadPanelDetail(selectedId);
        }
      }
    });
    return off;
  }, [loadCatalog, loadPanelDetail, open, selectedId]);

  useEffect(() => {
    const handler: ModalOpenListener = (requestedPanelId) => {
      setOpen(true);
      void (async () => {
        const res = await invokePortableCommand('panel', 'list --json', { timeoutMs: 4_000 });
        let nextPanels = panels;
        if (!res.error && res.message) {
          try {
            const parsed = JSON.parse(res.message) as PluginUiCatalogPayload;
            if (Array.isArray(parsed.statusChips)) setChips(parsed.statusChips);
            if (Array.isArray(parsed.panels)) {
              nextPanels = parsed.panels;
              setPanels(parsed.panels);
            }
          } catch {
            // ignore
          }
        }
        const target =
          (requestedPanelId
            ? nextPanels.find(
                (p) => p.qualifiedId === requestedPanelId || p.id === requestedPanelId,
              )?.qualifiedId
            : undefined) ??
          selectedId ??
          nextPanels[0]?.qualifiedId ??
          null;
        if (target) {
          await loadPanelDetail(target);
        } else {
          setActivePanel(null);
        }
      })();
    };
    modalOpenListeners.add(handler);
    return () => {
      modalOpenListeners.delete(handler);
    };
  }, [loadPanelDetail, panels, selectedId]);

  const triggerAction = async (panelId: string, actionId: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await invokePortableCommand('panel', `action ${panelId} ${actionId} --json`, {
        timeoutMs: 8_000,
      });
      if (res.error) {
        setError(res.error);
        return;
      }
      if (!res.message) return;
      const parsed = JSON.parse(res.message) as PluginUiCatalogPayload;
      if (parsed.error) {
        setError(parsed.error);
        return;
      }
      if (Array.isArray(parsed.statusChips)) setChips(parsed.statusChips);
      if (Array.isArray(parsed.panels)) setPanels(parsed.panels);
      if (parsed.activePanel) {
        setActivePanel(parsed.activePanel);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (chips.length === 0 && !open) return null;

  return (
    <>
      {chips.length > 0 ? (
        <div className="mx-2 mt-1.5 flex items-center justify-between gap-2 rounded-md border border-border/60 bg-card/50 px-2.5 py-1 sm:mx-3 lg:mx-4">
          <PluginStatusChipsBar
            chips={chips}
            onSelectChip={(chip) => {
              const ownerPanel = panels.find((p) => p.owner === chip.owner);
              openPluginUiModal(ownerPanel?.qualifiedId);
            }}
          />
          {panels.length > 0 ? (
            <button
              type="button"
              onClick={() => openPluginUiModal()}
              className="inline-flex shrink-0 items-center gap-1 rounded border border-border/70 bg-muted/40 px-2 py-0.5 text-[10px] font-medium text-foreground/85 hover:bg-muted"
            >
              <Blocks className="h-3 w-3 text-primary" />
              <span>Panels ({panels.length})</span>
            </button>
          ) : null}
        </div>
      ) : null}

      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-[1px]"
          role="dialog"
          aria-modal="true"
          aria-label="Plugin Panels"
          data-testid="plugin-ui-modal"
        >
          <div className="flex max-h-[82vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-border bg-card shadow-xl">
            <div className="flex items-center justify-between border-b border-border/70 px-4 py-2.5">
              <div className="flex items-center gap-2">
                <Blocks className="h-4 w-4 text-primary" />
                <h2 className="text-sm font-semibold">Plugin Panels</h2>
              </div>
              <div className="flex items-center gap-1.5">
                {selectedId ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void loadPanelDetail(selectedId)}
                    className="inline-flex items-center gap-1 rounded border border-border/70 px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                  >
                    <RefreshCw className={`h-3 w-3 ${busy ? 'animate-spin' : ''}`} />
                    Refresh
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label="Close plugin panels"
                  className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            {panels.length > 1 ? (
              <div className="flex flex-wrap gap-1 border-b border-border/60 bg-muted/20 px-4 py-2">
                {panels.map((p) => (
                  <button
                    key={p.qualifiedId}
                    type="button"
                    onClick={() => void loadPanelDetail(p.qualifiedId)}
                    className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                      p.qualifiedId === selectedId
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground'
                    }`}
                  >
                    {p.title}
                  </button>
                ))}
              </div>
            ) : null}

            <div className="min-h-0 flex-1 overflow-y-auto p-4 space-y-3">
              {error ? (
                <div className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  {error}
                </div>
              ) : null}

              {panels.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No declarative plugin UI panels are currently registered. Load a plugin that calls{' '}
                  <code>api.ui.registerPanel(...)</code> or run <code>/plugin reload</code>.
                </p>
              ) : activePanel ? (
                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <div className="text-xs font-semibold">{activePanel.title}</div>
                      <div className="font-mono text-[10px] text-muted-foreground">
                        {activePanel.qualifiedId} · owner: {activePanel.owner}
                      </div>
                    </div>
                    {activePanel.actions.length > 0 ? (
                      <div className="flex flex-wrap items-center gap-1.5">
                        {activePanel.actions.map((action) => (
                          <button
                            key={action.id}
                            type="button"
                            disabled={busy}
                            onClick={() => void triggerAction(activePanel.qualifiedId, action.id)}
                            className="inline-flex items-center gap-1 rounded border border-primary/40 bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary hover:bg-primary/20 disabled:opacity-50"
                          >
                            <span>{action.label}</span>
                            {action.shortcut ? (
                              <kbd className="rounded bg-background/80 px-1 font-mono text-[10px] text-muted-foreground">
                                {action.shortcut}
                              </kbd>
                            ) : null}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  <PluginViewNodeRenderer node={activePanel.view} />
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">Loading panel view…</p>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
