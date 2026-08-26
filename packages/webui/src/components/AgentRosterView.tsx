/**
 * AgentRosterView — comprehensive agent roster main view.
 *
 * A full-page view with tabbed sections:
 * 1. Live Fleet — real-time running/completed/failed agents from the fleet store
 * 2. Roster Catalog — all available agent roles with descriptions, budgets, tools
 * 3. Self-Learning — per-agent learning stats, capture history, entry browser
 * 4. Customization — identity.md, learned.md, config.json editing (integrates logic
 *    from CustomRosterPanel)
 *
 * This view is accessible via the "Agent Roster" icon in the activity bar.
 */

import {
  AlertTriangle,
  Bookmark,
  Database,
  FileText,
  Settings,
  ShieldCheck,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AgentRuntimePolicyEditor } from '@/components/AgentRuntimePolicyEditor';
import { useAppTranslation } from '@/i18n';
import { sendRosterMessage } from '@/lib/roster-ws';
import { cn } from '@/lib/utils';
import { getWSClient } from '@/lib/ws-client';
import { useChatStore, useUIStore } from '@/stores';
import { RosterCatalogTab } from './AgentRosterCatalogTab.js';
import { AgentRosterHeader, AgentRosterTabs } from './AgentRosterChrome.js';
import { LiveFleetTab } from './AgentRosterLiveTab.js';
import { SelfLearningTab } from './AgentRosterSelfLearningTab.js';
import { AudienceMemoryPanel } from './AudienceMemoryPanel.js';
/**
 * Trailing-debounce window for coalescing `agent-roster.updated` broadcasts.
 * A bulk optimize emits one event per role; without this, each would trigger
 * its own full roster reload. Reloading once after the burst settles is enough.
 */
import type { CustomRosterStats, RosterAgentEntry, RosterTab } from './agent-roster-data.js';
import { OfficeMapPanel } from './OfficeMapPanel.js';
import { useAgentRosterData } from './useAgentRosterData.js';

// ══════════════════════════════════════════════════════════════════════
//  TAB: Customization
// ══════════════════════════════════════════════════════════════════════

function CustomizationTab({
  customStats,
  catalog,
  onRefresh,
}: {
  customStats: CustomRosterStats[];
  catalog: RosterAgentEntry[];
  onRefresh: () => void;
}) {
  const { t } = useAppTranslation();
  const [selectedRole, setSelectedRole] = useState<string | null>(null);
  const [editMode, setEditMode] = useState<'identity' | 'learned' | 'config' | null>(null);
  const [editContent, setEditContent] = useState('');
  const [runtimeConfig, setRuntimeConfig] = useState<Record<string, unknown> | null>(null);
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createDraft, setCreateDraft] = useState({
    name: '',
    role: '',
    baseRole: 'generic',
    purpose: '',
    taskTypes: '',
  });

  const selectedStats = useMemo(
    () => (selectedRole ? customStats.find((r) => r.role === selectedRole) : null),
    [selectedRole, customStats],
  );
  const systemProtected = useMemo(() => {
    const entry = catalog.find((candidate) => candidate.role === selectedRole);
    return entry?.systemProtected ?? !entry?.custom;
  }, [catalog, selectedRole]);

  const startEdit = useCallback(async (role: string, mode: 'identity' | 'learned' | 'config') => {
    setSaving(true);
    setEditError(null);
    setSelectedRole(role);
    try {
      const data = (await sendRosterMessage('agent-roster.read-customization', { role })) as {
        identity: string;
        learned: string;
        config: Record<string, unknown>;
      };
      setEditContent(
        mode === 'config' ? `${JSON.stringify(data.config ?? {}, null, 2)}\n` : (data[mode] ?? ''),
      );
      setEditMode(mode);
      setRuntimeConfig(null);
    } catch (error) {
      setEditError(
        error instanceof Error ? error.message : t('activity:agentRoster.loadCustomizationFailed'),
      );
    } finally {
      setSaving(false);
    }
  }, []);

  const startRuntimeEdit = useCallback(async (role: string) => {
    setSaving(true);
    setEditError(null);
    setSelectedRole(role);
    try {
      const data = (await sendRosterMessage('agent-roster.read-customization', { role })) as {
        config: Record<string, unknown>;
      };
      setRuntimeConfig(data.config ?? {});
      setEditMode(null);
    } catch (error) {
      setEditError(
        error instanceof Error ? error.message : t('activity:agentRoster.loadRuntimePolicyFailed'),
      );
    } finally {
      setSaving(false);
    }
  }, []);

  const saveRuntimeConfig = useCallback(
    async (config: Record<string, unknown>) => {
      if (!selectedRole) return;
      setSaving(true);
      setEditError(null);
      try {
        await sendRosterMessage('agent-roster.update-config', { role: selectedRole, config });
        setRuntimeConfig(null);
        onRefresh();
      } catch (error) {
        setEditError(
          error instanceof Error
            ? error.message
            : t('activity:agentRoster.runtimePolicySaveFailed'),
        );
      } finally {
        setSaving(false);
      }
    },
    [onRefresh, selectedRole],
  );

  const saveEdit = useCallback(async () => {
    if (!selectedRole || !editMode) return;
    setSaving(true);
    try {
      const typeMap: Record<string, string> = {
        identity: 'agent-roster.update-identity',
        learned: 'agent-roster.update-learned',
        config: 'agent-roster.update-config',
      };
      const payload: Record<string, unknown> = { role: selectedRole };
      if (editMode === 'config') {
        try {
          payload.config = JSON.parse(editContent);
        } catch {
          setEditError('config.json must contain valid JSON');
          setSaving(false);
          return;
        }
      } else {
        payload.content = editContent;
      }
      await sendRosterMessage(typeMap[editMode], payload);
      setEditMode(null);
      setEditError(null);
      onRefresh();
    } catch (error) {
      setEditError(error instanceof Error ? error.message : t('activity:agentRoster.saveFailed'));
    }
    setSaving(false);
  }, [selectedRole, editMode, editContent, onRefresh]);

  const runImprove = useCallback(async () => {
    if (!selectedRole) return;
    try {
      const data = (await sendRosterMessage('agent-roster.llm-improve', {
        role: selectedRole,
        prompt: 'Improve this agent for optimal project performance',
      })) as { instruction: string };
      if (!data.instruction) throw new Error('No improvement instruction generated');
      const chat = useChatStore.getState();
      chat.addMessage({ role: 'user', content: data.instruction });
      chat.setLoading(true);
      getWSClient().sendMessage(data.instruction);
      const ui = useUIStore.getState();
      ui.setSidebarOpen(false);
      ui.setCurrentView('chat');
    } catch (error) {
      setEditError(
        error instanceof Error ? error.message : t('activity:agentRoster.llmImprovementFailed'),
      );
    }
  }, [selectedRole]);

  const runReset = useCallback(
    async (role: string) => {
      if (!window.confirm(t('activity:agentRoster.resetConfirm', { role }))) return;
      try {
        await sendRosterMessage('agent-roster.reset', { role });
        setSelectedRole(null);
        onRefresh();
      } catch {
        /* ignore */
      }
    },
    [onRefresh],
  );

  const runCreate = useCallback(async () => {
    const taskTypes = createDraft.taskTypes
      .split(/[\n,]+/)
      .map((item) => item.trim())
      .filter(Boolean);
    setSaving(true);
    setEditError(null);
    try {
      const data = (await sendRosterMessage('agent-roster.create', {
        name: createDraft.name,
        role: createDraft.role,
        baseRole: createDraft.baseRole,
        purpose: createDraft.purpose,
        taskTypes,
      })) as { role: string; success: boolean };
      setCreateOpen(false);
      setCreateDraft({ name: '', role: '', baseRole: 'generic', purpose: '', taskTypes: '' });
      setSelectedRole(data.role);
      onRefresh();
    } catch (error) {
      setEditError(
        error instanceof Error ? error.message : t('activity:agentRoster.agentCreationFailed'),
      );
    } finally {
      setSaving(false);
    }
  }, [createDraft, onRefresh]);

  const sorted = useMemo(
    () =>
      [...customStats].sort((a, b) => {
        const aScore = (a.hasIdentity ? 1 : 0) + (a.entryCount > 0 ? 1 : 0) + (a.hasConfig ? 1 : 0);
        const bScore = (b.hasIdentity ? 1 : 0) + (b.entryCount > 0 ? 1 : 0) + (b.hasConfig ? 1 : 0);
        return bScore - aScore;
      }),
    [customStats],
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
      {/* Left sidebar */}
      <div className="w-80 shrink-0 border-r border-border/50 flex flex-col overflow-hidden">
        <div className="shrink-0 border-b border-border/50 px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <h3 className="flex items-center gap-1.5 text-xs font-semibold">
              <Settings className="h-3.5 w-3.5" />
              {t('activity:agentRoster.projectAgents')}
            </h3>
            <button
              type="button"
              onClick={() => {
                setCreateOpen(true);
                setSelectedRole(null);
                setRuntimeConfig(null);
                setEditError(null);
              }}
              className="rounded border border-primary/40 px-1.5 py-1 text-[9px] text-primary hover:bg-primary/10"
            >
              {t('activity:agentRoster.clone')}
            </button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2 space-y-1">
          {sorted.map((stat) => (
            <button
              key={stat.role}
              type="button"
              onClick={() => {
                setSelectedRole(stat.role);
                setRuntimeConfig(null);
                setEditMode(null);
              }}
              className={cn(
                'w-full text-left rounded-lg border px-3 py-2 transition-colors',
                selectedRole === stat.role
                  ? 'border-primary/50 bg-primary/[0.06]'
                  : 'border-border/60 hover:border-primary/30',
              )}
            >
              <div className="text-xs font-semibold">{stat.role}</div>
              <div className="flex gap-2 mt-0.5 text-[9px] text-muted-foreground">
                {stat.hasIdentity && <span className="text-primary">id</span>}
                {stat.entryCount > 0 && <span className="text-brand-2">{stat.entryCount}e</span>}
                {stat.hasConfig && <span>cfg</span>}
              </div>
            </button>
          ))}
          {sorted.length === 0 && (
            <div className="text-[10px] text-muted-foreground text-center py-4">
              {t('activity:agentRoster.noCustomizations')}
            </div>
          )}
        </div>
      </div>

      {/* Editor */}
      <div className="flex-1 min-h-0 min-w-0 overflow-y-auto p-4">
        {createOpen && (
          <div className="max-w-2xl space-y-4">
            <div>
              <h3 className="text-base font-semibold">
                {t('activity:agentRoster.createOrCloneTitle')}
              </h3>
              <p className="mt-1 text-xs text-muted-foreground">
                {t('activity:agentRoster.createOrCloneHint')}
              </p>
            </div>
            <label className="block space-y-1 text-xs">
              <span className="font-medium">{t('activity:agentRoster.cloneFromRole')}</span>
              <select
                value={createDraft.baseRole}
                onChange={(event) =>
                  setCreateDraft((draft) => ({ ...draft, baseRole: event.target.value }))
                }
                className="h-9 w-full rounded border border-border bg-card px-2"
              >
                {[...catalog]
                  .sort((a, b) => a.name.localeCompare(b.name))
                  .map((entry) => (
                    <option key={entry.role} value={entry.role}>
                      {entry.name} ({entry.role})
                    </option>
                  ))}
              </select>
              <p className="text-[10px] text-muted-foreground">
                {t('activity:agentRoster.cloneHint')}
              </p>
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1 text-xs">
                <span className="font-medium">{t('activity:agentRoster.displayName')}</span>
                <input
                  value={createDraft.name}
                  onChange={(event) =>
                    setCreateDraft((draft) => ({ ...draft, name: event.target.value }))
                  }
                  placeholder={t('activity:agentRoster.abc')}
                  className="h-9 w-full rounded border border-border bg-card px-2"
                />
              </label>
              <label className="space-y-1 text-xs">
                <span className="font-medium">{t('activity:agentRoster.roleIdOptional')}</span>
                <input
                  value={createDraft.role}
                  onChange={(event) =>
                    setCreateDraft((draft) => ({ ...draft, role: event.target.value }))
                  }
                  placeholder={t('activity:agentRoster.abcGeneratedFromName')}
                  className="h-9 w-full rounded border border-border bg-card px-2 font-mono"
                />
              </label>
            </div>
            <label className="block space-y-1 text-xs">
              <span className="font-medium">{t('activity:agentRoster.purpose')}</span>
              <textarea
                value={createDraft.purpose}
                onChange={(event) =>
                  setCreateDraft((draft) => ({ ...draft, purpose: event.target.value }))
                }
                placeholder={t('activity:agentRoster.descriptionPlaceholder')}
                className="h-24 w-full resize-y rounded border border-border bg-card p-2"
              />
            </label>
            <label className="block space-y-1 text-xs">
              <span className="font-medium">
                {t('activity:agentRoster.taskTypesCommaOrOnePer')}
              </span>
              <textarea
                value={createDraft.taskTypes}
                onChange={(event) =>
                  setCreateDraft((draft) => ({ ...draft, taskTypes: event.target.value }))
                }
                placeholder={t('activity:agentRoster.taskTypesPlaceholder')}
                className="h-24 w-full resize-y rounded border border-border bg-card p-2"
              />
            </label>
            {editError && <p className="text-xs text-destructive">{editError}</p>}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={runCreate}
                disabled={
                  saving ||
                  !createDraft.name.trim() ||
                  createDraft.purpose.trim().length < 10 ||
                  !createDraft.taskTypes.trim()
                }
                className="rounded bg-primary px-3 py-1.5 text-xs text-primary-foreground disabled:opacity-50"
              >
                {saving ? t('activity:agentRoster.creating') : 'Clone Agent'}
              </button>
              <button
                type="button"
                onClick={() => setCreateOpen(false)}
                className="rounded border border-border px-3 py-1.5 text-xs hover:bg-accent"
              >
                {t('activity:agentRoster.cancel')}
              </button>
            </div>
          </div>
        )}
        {!createOpen && !selectedRole && (
          <div className="flex items-center justify-center h-full text-muted-foreground">
            {t('activity:agentRoster.selectAnAgentToEditCustomizations')}
          </div>
        )}
        {!createOpen && selectedRole && selectedStats && (
          <div className="space-y-4 max-w-2xl">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold">{selectedRole}</h3>
              <div className="flex gap-1">
                <button
                  type="button"
                  onClick={runImprove}
                  className="inline-flex items-center gap-1 rounded border border-border/50 px-2 py-1 text-[10px] hover:bg-accent transition-colors"
                >
                  <Sparkles className="h-3 w-3 text-brand-2" />{' '}
                  {t('activity:agentRoster.llmImprove')}
                </button>
                <button
                  type="button"
                  onClick={() => runReset(selectedRole)}
                  className="inline-flex items-center gap-1 rounded border border-destructive/30 px-2 py-1 text-[10px] text-destructive hover:bg-destructive/10 transition-colors"
                >
                  <Trash2 className="h-3 w-3" /> {t('activity:agentRoster.reset')}
                </button>
              </div>
            </div>

            {/* Stat badges */}
            <div className="flex flex-wrap gap-2">
              {selectedStats.hasIdentity && (
                <span className="inline-flex items-center gap-1 rounded bg-primary/10 px-2 py-1 text-[10px] text-primary">
                  <FileText className="h-3 w-3" /> identity.md
                </span>
              )}
              {selectedStats.hasConfig && (
                <span className="inline-flex items-center gap-1 rounded bg-muted px-2 py-1 text-[10px] text-muted-foreground">
                  <Settings className="h-3 w-3" /> config.json
                </span>
              )}
              {selectedStats.hasKnowledge && (
                <span className="inline-flex items-center gap-1 rounded bg-muted px-2 py-1 text-[10px] text-muted-foreground">
                  <Database className="h-3 w-3" /> knowledge.json
                </span>
              )}
              {selectedStats.entryCount > 0 && (
                <span className="inline-flex items-center gap-1 rounded bg-brand-2/10 px-2 py-1 text-[10px] text-brand-2">
                  <Bookmark className="h-3 w-3" /> {selectedStats.entryCount} learned entries
                </span>
              )}
            </div>

            {/* Edit buttons */}
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => startEdit(selectedRole, 'identity')}
                className="inline-flex items-center gap-1 rounded border border-border/50 px-3 py-1.5 text-xs hover:bg-accent transition-colors"
              >
                <FileText className="h-3.5 w-3.5" /> {t('activity:agentRoster.editIdentityMd')}
              </button>
              <button
                type="button"
                onClick={() => startEdit(selectedRole, 'learned')}
                className="inline-flex items-center gap-1 rounded border border-border/50 px-3 py-1.5 text-xs hover:bg-accent transition-colors"
              >
                <Bookmark className="h-3.5 w-3.5" /> {t('activity:agentRoster.editLearnedMd')}
              </button>
              <button
                type="button"
                onClick={() => startRuntimeEdit(selectedRole)}
                className="inline-flex items-center gap-1 rounded border border-primary/40 bg-primary/5 px-3 py-1.5 text-xs text-primary hover:bg-primary/10 transition-colors"
              >
                <ShieldCheck className="h-3.5 w-3.5" /> {t('activity:agentRoster.runtimePolicy')}
              </button>
              <button
                type="button"
                onClick={() => startEdit(selectedRole, 'config')}
                className="inline-flex items-center gap-1 rounded border border-border/50 px-3 py-1.5 text-xs hover:bg-accent transition-colors"
              >
                <Settings className="h-3.5 w-3.5" /> {t('activity:agentRoster.editConfigJson')}
              </button>
            </div>

            {editError && <p className="text-xs text-destructive">{editError}</p>}

            {runtimeConfig && (
              <AgentRuntimePolicyEditor
                key={selectedRole}
                initialConfig={runtimeConfig}
                systemProtected={systemProtected}
                saving={saving}
                onSave={saveRuntimeConfig}
                onCancel={() => setRuntimeConfig(null)}
              />
            )}

            {/* Inline editor */}
            {editMode && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium">
                    {editMode}.md / {editMode}.json
                  </span>
                  <div className="flex gap-1">
                    <button
                      type="button"
                      onClick={saveEdit}
                      disabled={saving}
                      className="inline-flex items-center gap-1 rounded bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
                    >
                      {saving ? t('activity:agentRoster.saving') : t('common:action.save')}
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditMode(null)}
                      className="inline-flex items-center gap-1 rounded border border-border/50 px-3 py-1.5 text-xs hover:bg-accent transition-colors"
                    >
                      {t('activity:agentRoster.cancel')}
                    </button>
                  </div>
                </div>
                <textarea
                  className="w-full h-48 font-mono text-xs p-2 bg-card border border-border rounded resize-y"
                  value={editContent}
                  onChange={(e) => setEditContent(e.target.value)}
                  placeholder={
                    editMode === 'config'
                      ? '{ "tools": [...], "budget": {...} }'
                      : `# Project identity for ${selectedRole}\n\nDescribe this agent's role…`
                  }
                />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════
//  MAIN: AgentRosterView
// ══════════════════════════════════════════════════════════════════════

export function AgentRosterView({
  className,
  initialTab = 'live',
}: {
  className?: string | undefined;
  initialTab?: RosterTab | undefined;
}) {
  const { t } = useAppTranslation();
  const storeActiveTab = useUIStore((s) => s.agentRosterActiveTab);
  const setStoreActiveTab = useUIStore((s) => s.setAgentRosterActiveTab);
  const [localActiveTab, setLocalActiveTab] = useState<RosterTab>(initialTab);
  const activeTab = storeActiveTab ?? localActiveTab;
  const setActiveTab = useCallback(
    (tab: RosterTab) => {
      setLocalActiveTab(tab);
      if (typeof setStoreActiveTab === 'function') {
        setStoreActiveTab(tab);
      }
    },
    [setStoreActiveTab],
  );
  const [nowTick, setNowTick] = useState(Date.now());
  const { customStats, catalog, rosterLoading, rosterError, loadRoster } = useAgentRosterData();

  // Live clock for elapsed display
  useEffect(() => {
    const id = setInterval(() => {
      if (!document.hidden) setNowTick(Date.now());
    }, 2000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className={cn('flex h-full min-h-0 min-w-0 w-full flex-col overflow-hidden', className)}>
      <AgentRosterHeader
        customStats={customStats}
        rosterLoading={rosterLoading}
        onRefresh={loadRoster}
      />
      <AgentRosterTabs activeTab={activeTab} onTabChange={setActiveTab} />

      {/* ── Tab content ── */}
      <div className="flex min-h-0 min-w-0 w-full flex-1 overflow-hidden bg-background/50">
        {rosterError && (
          <div className="flex items-center justify-center w-full text-destructive text-xs gap-2">
            <AlertTriangle className="h-4 w-4" />
            {rosterError}
            <button type="button" onClick={loadRoster} className="underline">
              {t('activity:agentRoster.retry')}
            </button>
          </div>
        )}

        {activeTab === 'live' && <LiveFleetTab nowTick={nowTick} />}
        {activeTab === 'officemap' && <OfficeMapPanel />}
        {activeTab === 'catalog' && (
          <RosterCatalogTab customStats={customStats} catalog={catalog} />
        )}
        {activeTab === 'learning' && (
          <SelfLearningTab customStats={customStats} onRefresh={loadRoster} />
        )}
        {activeTab === 'memory' && <AudienceMemoryPanel />}
        {activeTab === 'customize' && (
          <CustomizationTab customStats={customStats} catalog={catalog} onRefresh={loadRoster} />
        )}
      </div>
    </div>
  );
}
