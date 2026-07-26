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
  BookOpen,
  CheckCircle2,
  Database,
  FileText,
  Library,
  Loader2,
  RefreshCw,
  Settings,
  ShieldCheck,
  Sparkles,
  Trash2,
  Zap,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AgentRuntimePolicyEditor } from '@/components/AgentRuntimePolicyEditor';
import { toast } from '@/components/Toaster';
import { sendRosterMessage } from '@/lib/roster-ws';
import { cn } from '@/lib/utils';
import { getWSClient } from '@/lib/ws-client';
import { useChatStore, useUIStore } from '@/stores';
import { RosterCatalogTab } from './AgentRosterCatalogTab.js';
import { LiveFleetTab } from './AgentRosterLiveTab.js';
/**
 * Trailing-debounce window for coalescing `agent-roster.updated` broadcasts.
 * A bulk optimize emits one event per role; without this, each would trigger
 * its own full roster reload. Reloading once after the burst settles is enough.
 */
import {
  type CustomRosterStats,
  KNOWN_ROLES,
  ROSTER_UPDATE_DEBOUNCE_MS,
  type RosterAgentEntry,
  type RosterTab,
  TABS,
} from './agent-roster-data.js';

function SelfLearningTab({
  customStats,
  onRefresh,
}: {
  customStats: CustomRosterStats[];
  onRefresh: () => void;
}) {
  const [selectedRole, setSelectedRole] = useState<string | null>(null);
  const [reviewEntries, setReviewEntries] = useState<string[] | null>(null);
  const [reviewDecisions, setReviewDecisions] = useState<Record<number, 'keep' | 'drop'>>({});
  const [teachInput, setTeachInput] = useState('');
  const [teachFeedback, setTeachFeedback] = useState<{ ok: boolean; msg: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [loadingEntries, setLoadingEntries] = useState(false);
  const [consolidatedContent, setConsolidatedContent] = useState<string | null>(null);
  const [optimizing, setOptimizing] = useState(false);
  const [bulkOptimizing, setBulkOptimizing] = useState(false);

  const populated = useMemo(
    () => [...customStats].sort((a, b) => a.role.localeCompare(b.role)),
    [customStats],
  );
  const selectedStats = useMemo(
    () => (selectedRole ? populated.find((r) => r.role === selectedRole) : null),
    [selectedRole, populated],
  );

  // Load review entries
  const loadEntries = useCallback(async (role: string) => {
    setLoadingEntries(true);
    setReviewEntries(null);
    try {
      const data = (await sendRosterMessage('agent-roster.read-learned', { role })) as {
        entries: string[];
      };
      setReviewEntries(data.entries ?? []);
      setReviewDecisions({});
    } catch {
      /* ignore */
    }
    setLoadingEntries(false);
  }, []);

  // Apply review decisions
  const applyReview = useCallback(async () => {
    if (!selectedRole || !reviewEntries) return;
    setSaving(true);
    const kept = reviewEntries.filter((_, i) => reviewDecisions[i] !== 'drop');
    const content = kept.join('\n\n---\n\n');
    try {
      await sendRosterMessage('agent-roster.update-learned', { role: selectedRole, content });
      setReviewEntries(null);
      setReviewDecisions({});
    } catch {
      /* ignore */
    }
    setSaving(false);
  }, [selectedRole, reviewEntries, reviewDecisions]);

  // Teach
  const runTeach = useCallback(async () => {
    if (!selectedRole || !teachInput.trim()) return;
    setTeachFeedback(null);
    setSaving(true);
    try {
      const content = `> Taught ${new Date().toISOString().slice(0, 10)}\n\n${teachInput.trim()}`;
      const data = (await sendRosterMessage('agent-roster.append-learned', {
        role: selectedRole,
        content,
      })) as { success: boolean };
      if (data.success) {
        setTeachFeedback({ ok: true, msg: 'Saved to learned.md' });
        setTeachInput('');
        onRefresh();
      } else {
        setTeachFeedback({ ok: false, msg: 'Save failed' });
      }
    } catch (err) {
      setTeachFeedback({ ok: false, msg: err instanceof Error ? err.message : 'Failed' });
    }
    setSaving(false);
  }, [onRefresh, selectedRole, teachInput]);

  const setLearningEnabled = useCallback(
    async (role: string, enabled: boolean) => {
      setSaving(true);
      setTeachFeedback(null);
      try {
        const result = (await sendRosterMessage('agent-roster.update-learning', {
          role,
          enabled,
        })) as { success?: boolean; error?: string };
        if (result.error) throw new Error(result.error);
        setTeachFeedback({
          ok: true,
          msg: enabled ? 'Automatic learning resumed' : 'Automatic learning paused',
        });
        onRefresh();
      } catch (error) {
        setTeachFeedback({
          ok: false,
          msg: error instanceof Error ? error.message : 'Policy update failed',
        });
      } finally {
        setSaving(false);
      }
    },
    [onRefresh],
  );

  // Load consolidated content
  const loadConsolidated = useCallback(async (role: string) => {
    try {
      const data = (await sendRosterMessage('agent-roster.read-consolidated', { role })) as {
        content: string;
        isConsolidated: boolean;
      };
      setConsolidatedContent(data.isConsolidated ? data.content : null);
    } catch {
      setConsolidatedContent(null);
    }
  }, []);

  // Optimize learnings — runs the LLM consolidation headlessly on the server
  // (read raw entries → synthesize → write consolidated.md + consolidation.json)
  // and reflects the result inline, with NO chat round-trip. If the server has
  // no active model it degrades to the legacy chat-driven path.
  const runOptimize = useCallback(
    async (role: string) => {
      setOptimizing(true);
      setTeachFeedback(null);
      try {
        const data = (await sendRosterMessage('agent-roster.consolidate', { role })) as {
          consolidated?: boolean;
          emptySynthesis?: boolean;
          instruction?: string;
          leaderInstruction?: string;
          rawEntryCount?: number;
          content?: string;
          model?: string;
          error?: string;
        };
        if (data.error) throw new Error(data.error);
        if (data.rawEntryCount === 0) {
          setTeachFeedback({ ok: false, msg: 'No raw entries to optimize yet.' });
          return;
        }

        // ── Headless success: the server already synthesized + persisted. ──
        if (data.consolidated) {
          await onRefresh();
          // Reconcile the visible document from the server; this supersedes any
          // optimistic set of `data.content` (which would otherwise be dead work).
          // Always reload — `loadConsolidated` self-guards via `setConsolidatedContent`,
          // so gating on a possibly-stale `selectedRole` closure is unnecessary and
          // could leave the freshly-optimized document out of sync.
          await loadConsolidated(role);
          setTeachFeedback({ ok: true, msg: 'Optimized. Consolidated knowledge updated.' });
          toast.success(
            data.model ? `Learnings consolidated with ${data.model}.` : 'Learnings consolidated.',
          );
          return;
        }

        // ── Empty synthesis: the model ran but produced nothing usable. The
        // existing document is left untouched; surface a retryable message. ──
        if (data.emptySynthesis) {
          setTeachFeedback({
            ok: false,
            msg: 'The model returned an empty result. Nothing was changed — try again.',
          });
          toast.error('Optimization produced an empty result. Try again.');
          return;
        }

        // ── Fallback: no active model on the server. Route the full
        // instruction through the chat agent so the work still completes. ──
        const prompt = data.instruction;
        if (!prompt) throw new Error('No consolidation instruction generated');
        const chat = useChatStore.getState();
        chat.addMessage({ role: 'user', content: prompt });
        chat.setLoading(true);
        getWSClient().sendMessage(prompt);
        const ui = useUIStore.getState();
        ui.setSidebarOpen(false);
        ui.setCurrentView('chat');
        setTeachFeedback({
          ok: true,
          msg: 'No active model on server — optimization sent to chat agent instead.',
        });
        toast.info('No active model on server. Optimization sent to the chat agent.');
      } catch (err) {
        setTeachFeedback({
          ok: false,
          msg: err instanceof Error ? err.message : 'Optimization failed',
        });
        toast.error(err instanceof Error ? err.message : 'Optimization failed');
      } finally {
        setOptimizing(false);
      }
    },
    [onRefresh, loadConsolidated],
  );

  // Bulk optimize — consolidates each agent headlessly on the server. Agents
  // that the server could consolidate directly are done inline; only agents
  // that fall back (no active model) are collected and routed through the chat
  // agent as a single combined prompt.
  const runBulkOptimize = useCallback(
    async (roles: string[]) => {
      if (roles.length === 0) return;
      setBulkOptimizing(true);
      setTeachFeedback(null);
      try {
        // Serialize requests to avoid the per-type gate in sendRosterMessage
        // ("Roster request 'agent-roster.consolidate' superseded by new request").
        // Each individual failure is isolated so the rest of the batch survives.
        const consolidatedRoles: string[] = [];
        let skippedCount = 0;
        let failedCount = 0;
        let lastErrorMsg = '';
        const fallback: Array<{ role: string; instruction: string }> = [];
        for (const r of roles) {
          try {
            const data = (await sendRosterMessage('agent-roster.consolidate', {
              role: r,
            })) as {
              consolidated?: boolean;
              emptySynthesis?: boolean;
              instruction?: string;
              rawEntryCount?: number;
              error?: string;
            };
            if (data.error) {
              failedCount++;
              lastErrorMsg = data.error;
            } else if (data.consolidated) {
              // Server synthesized + persisted this one directly.
              consolidatedRoles.push(r);
            } else if (data.rawEntryCount === 0) {
              // No entries to optimize — legitimate skip, not a failure.
              skippedCount++;
            } else if (data.emptySynthesis) {
              // Model ran but produced nothing usable — count as a failure
              // with a clear reason; the existing document is untouched.
              failedCount++;
              lastErrorMsg = 'Model returned an empty result';
            } else if (data.instruction) {
              // No active model on the server — needs the chat fallback.
              fallback.push({ role: r, instruction: data.instruction });
            } else {
              failedCount++;
              lastErrorMsg = 'No consolidation produced';
            }
          } catch (err) {
            failedCount++;
            lastErrorMsg = err instanceof Error ? err.message : String(err);
          }
        }

        // No explicit roster refresh here: each server-side consolidation emits
        // an `agent-roster.updated` broadcast, and the debounced listener
        // coalesces the whole burst into a single `loadRoster()` — avoiding an
        // N+1 reload. The broadcast refreshes the roster *list*, but not the
        // currently-open consolidated *document*, so reload that explicitly for
        // the selected role if it was one of the consolidated ones — parity with
        // the single-role `runOptimize` path.
        if (selectedRole && consolidatedRoles.includes(selectedRole)) {
          await loadConsolidated(selectedRole);
        }

        // Route only the fallback agents through chat, as one combined prompt.
        if (fallback.length > 0) {
          const prompt =
            `Optimize the learned data for ${fallback.length} agent${fallback.length > 1 ? 's' : ''}. ` +
            `For each agent below, read its raw learned entries, synthesize them into a single narrowly-scoped ` +
            `document preserving every fact, and save the result to its consolidated.md file.\n\n` +
            fallback.map((r) => `## Agent: ${r.role}\n\n${r.instruction}`).join('\n\n---\n\n');
          const chat = useChatStore.getState();
          chat.addMessage({ role: 'user', content: prompt });
          chat.setLoading(true);
          getWSClient().sendMessage(prompt);
          const ui = useUIStore.getState();
          ui.setSidebarOpen(false);
          ui.setCurrentView('chat');
        }

        // Summarize the batch outcome.
        if (consolidatedRoles.length === 0 && fallback.length === 0) {
          if (failedCount > 0) {
            const skipSuffix = skippedCount > 0 ? ` ${skippedCount} skipped.` : '';
            const diagnostic = `Bulk consolidate failed for ${failedCount} of ${roles.length} agent${roles.length > 1 ? 's' : ''}.${lastErrorMsg ? ` Last error: ${lastErrorMsg}` : ''}${skipSuffix}`;
            setTeachFeedback({ ok: false, msg: diagnostic });
            return;
          }
          // Skipped-only outcome (no entries to optimize) is a normal no-op,
          // not a failure — report it as info.
          const info =
            skippedCount > 0
              ? `Bulk optimize: ${skippedCount} skipped (no entries to optimize).`
              : 'No agents had optimizable entries.';
          setTeachFeedback({ ok: true, msg: info });
          toast.info(info, 6000);
          return;
        }

        const parts: string[] = [];
        if (consolidatedRoles.length > 0) parts.push(`${consolidatedRoles.length} consolidated`);
        if (fallback.length > 0) parts.push(`${fallback.length} sent to chat`);
        if (skippedCount > 0) parts.push(`${skippedCount} skipped`);
        if (failedCount > 0) parts.push(`${failedCount} failed`);
        const summary = `Bulk optimize: ${parts.join(', ')}.`;
        setTeachFeedback({ ok: failedCount === 0, msg: summary });
        if (consolidatedRoles.length > 0 && fallback.length === 0) {
          toast.success(summary, 6000);
        } else {
          toast.info(summary, 6000);
        }
      } catch (err) {
        setTeachFeedback({
          ok: false,
          msg: err instanceof Error ? err.message : 'Bulk optimization failed',
        });
        toast.error(err instanceof Error ? err.message : 'Bulk optimization failed');
      } finally {
        setBulkOptimizing(false);
      }
    },
    [selectedRole, loadConsolidated],
  );

  if (populated.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        <div className="text-center space-y-3">
          <Database className="h-10 w-10 mx-auto opacity-30" />
          <p className="text-sm">No self-learning data yet</p>
          <p className="text-xs text-muted-foreground/70">
            Learning entries appear when agents capture output
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
      {/* Left: agent list with learning stats */}
      <div
        className={cn(
          'flex flex-col min-h-0 min-w-0 overflow-hidden border-r border-border/50',
          selectedRole ? 'w-80 shrink-0' : 'flex-1',
        )}
      >
        <div className="shrink-0 px-3 py-2 border-b border-border/50">
          <h3 className="text-xs font-semibold flex items-center gap-1.5">
            <Database className="h-3.5 w-3.5 text-brand-2" />
            All Roster Agents
          </h3>
          {(() => {
            const needsOpt = populated.filter((s) => s.needsSummarization);
            if (needsOpt.length === 0) return null;
            return (
              <div className="mt-2 flex flex-col gap-1.5 rounded border border-warning/40 bg-warning/10 px-2 py-1.5">
                <div className="flex items-center gap-2">
                  <Zap className="h-3 w-3 text-warning shrink-0" />
                  <span className="text-[10px] text-warning leading-tight">
                    {needsOpt.length} agent{needsOpt.length > 1 ? 's' : ''} need
                    {needsOpt.length === 1 ? 's' : ''} optimization
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      const first = needsOpt[0];
                      if (first) {
                        setSelectedRole(first.role);
                        setReviewEntries(null);
                        setConsolidatedContent(null);
                      }
                    }}
                    className="ml-auto text-[9px] text-warning underline hover:text-warning/80 shrink-0"
                  >
                    review →
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => runBulkOptimize(needsOpt.map((s) => s.role))}
                  disabled={bulkOptimizing}
                  className="flex items-center justify-center gap-1 rounded bg-warning/20 border border-warning/40 px-2 py-1 text-[10px] font-medium text-warning hover:bg-warning/30 transition-colors disabled:opacity-50"
                >
                  {bulkOptimizing ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Zap className="h-3 w-3" />
                  )}
                  {bulkOptimizing ? 'Optimizing…' : `Optimize All (${needsOpt.length})`}
                </button>
              </div>
            );
          })()}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2 space-y-1">
          {populated.map((stat) => (
            <button
              key={stat.role}
              type="button"
              onClick={() => {
                setSelectedRole(stat.role);
                setReviewEntries(null);
                setConsolidatedContent(null);
              }}
              className={cn(
                'w-full text-left rounded-lg border px-3 py-2 transition-colors',
                selectedRole === stat.role
                  ? 'border-primary/50 bg-primary/[0.06]'
                  : 'border-border/60 hover:border-primary/30',
                stat.needsSummarization && selectedRole !== stat.role && 'border-warning/40',
              )}
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold">{stat.role}</span>
                <span
                  className={cn(
                    'text-[9px] tabular-nums',
                    stat.learningEnabled ? 'text-success' : 'text-muted-foreground',
                  )}
                >
                  {stat.learningEnabled ? 'learning' : 'paused'}
                </span>
              </div>
              <div className="flex items-center gap-2 mt-1 text-[9px] text-muted-foreground">
                <span className="tabular-nums">{stat.entryCount} entries</span>
                {stat.sessionCaptureCount > 0 && (
                  <>
                    <span className="text-muted-foreground/50">·</span>
                    <span className="text-success tabular-nums">+{stat.sessionCaptureCount}</span>
                  </>
                )}
                {stat.lastCapture && (
                  <>
                    <span className="text-muted-foreground/50">·</span>
                    <span>{new Date(stat.lastCapture).toLocaleDateString()}</span>
                  </>
                )}
                {stat.needsSummarization && (
                  <span className="inline-flex items-center gap-0.5 text-warning font-medium">
                    <Zap className="h-2.5 w-2.5" />
                    optimize
                  </span>
                )}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Right: detail */}
      <div className="flex-1 min-w-0 overflow-y-auto p-4">
        {!selectedRole && (
          <div className="flex items-center justify-center h-full text-muted-foreground">
            Select an agent to view learning details
          </div>
        )}
        {selectedRole && selectedStats && (
          <div className="space-y-4">
            {/* Header */}
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold">{selectedRole}</h3>
              <div className="flex gap-1">
                <button
                  type="button"
                  onClick={() => setLearningEnabled(selectedRole, !selectedStats.learningEnabled)}
                  disabled={saving}
                  className={cn(
                    'inline-flex items-center gap-1 rounded border px-2 py-1 text-[10px] transition-colors disabled:opacity-50',
                    selectedStats.learningEnabled
                      ? 'border-success/40 text-success hover:bg-success/10'
                      : 'border-border/50 text-muted-foreground hover:bg-accent',
                  )}
                >
                  <Database className="h-3 w-3" />{' '}
                  {selectedStats.learningEnabled ? 'Learning on' : 'Learning paused'}
                </button>
              </div>
            </div>

            {/* Stats cards */}
            <div className="grid grid-cols-4 gap-2">
              <div className="rounded-lg border bg-card p-2">
                <span className="text-[9px] text-muted-foreground uppercase tracking-wider">
                  Entries
                </span>
                <div className="text-lg font-mono font-semibold mt-0.5">
                  {selectedStats.entryCount}
                </div>
              </div>
              <div className="rounded-lg border bg-card p-2">
                <span className="text-[9px] text-muted-foreground uppercase tracking-wider">
                  Size
                </span>
                <div className="text-lg font-mono font-semibold mt-0.5">
                  {selectedStats.totalBytes}B
                </div>
              </div>
              <div className="rounded-lg border bg-card p-2">
                <span className="text-[9px] text-muted-foreground uppercase tracking-wider">
                  Last Capture
                </span>
                <div className="text-lg font-mono font-semibold mt-0.5">
                  {selectedStats.lastCapture
                    ? new Date(selectedStats.lastCapture).toLocaleDateString()
                    : '—'}
                </div>
              </div>
              <div className="rounded-lg border bg-card p-2">
                <span className="text-[9px] text-muted-foreground uppercase tracking-wider">
                  Lifetime Captures
                </span>
                <div className="text-lg font-mono font-semibold mt-0.5">
                  {selectedStats.lifetimeCaptureCount}
                </div>
              </div>
            </div>

            {/* Proactive optimization warning */}
            {selectedStats.needsSummarization && (
              <div className="flex items-center gap-3 text-xs text-warning bg-warning/10 rounded-lg px-3 py-2.5">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                <span className="flex-1">
                  Learned data exceeds soft limit ({selectedStats.totalBytes.toLocaleString()}B /
                  8,192B). Optimize to synthesize raw entries into a consolidated document and
                  reduce context volume.
                </span>
                <button
                  type="button"
                  onClick={() => runOptimize(selectedRole)}
                  disabled={optimizing}
                  className="inline-flex items-center gap-1 rounded bg-warning/20 text-warning border border-warning/40 px-2.5 py-1 text-[10px] font-medium hover:bg-warning/30 transition-colors disabled:opacity-50 shrink-0"
                >
                  {optimizing ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Zap className="h-3 w-3" />
                  )}
                  {optimizing ? 'Optimizing…' : 'Optimize Now'}
                </button>
              </div>
            )}

            {/* Optimization / Consolidation section */}
            <div className="space-y-2 border border-border rounded-lg p-3 bg-card">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5">
                  <Sparkles className="h-4 w-4 text-primary" />
                  <span className="text-xs font-semibold">Optimize Learnings</span>
                </div>
                <button
                  type="button"
                  onClick={() => runOptimize(selectedRole)}
                  disabled={optimizing || selectedStats.entryCount === 0}
                  className="inline-flex items-center gap-1 rounded bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
                  title={
                    selectedStats.entryCount === 0
                      ? 'No raw entries to optimize'
                      : 'Synthesize raw entries into a consolidated, narrowly-scoped document'
                  }
                >
                  {optimizing ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Zap className="h-3.5 w-3.5" />
                  )}
                  {optimizing ? 'Optimizing…' : 'Optimize'}
                </button>
              </div>
              <p className="text-[10px] text-muted-foreground leading-relaxed">
                Synthesizes all {selectedStats.entryCount} raw entries into a single reviewed
                document — narrowly scoped to this agent's skills, preserving every fact but
                reducing context volume. The result replaces raw entries in the agent's prompt.
              </p>
              {/* Consolidation status */}
              {selectedStats.isConsolidated && selectedStats.consolidation && (
                <div className="flex items-center gap-2 text-[10px] text-muted-foreground pt-1 border-t border-border/50">
                  <CheckCircle2 className="h-3 w-3 text-success" />
                  <span>
                    Consolidated{' '}
                    {new Date(selectedStats.consolidation.consolidatedAt).toLocaleDateString()} ·{' '}
                    {selectedStats.consolidation.sourceBytes}B →{' '}
                    {selectedStats.consolidation.consolidatedBytes}B
                    {selectedStats.consolidation.sourceEntryCount < selectedStats.entryCount && (
                      <span className="text-warning ml-1">
                        · {selectedStats.entryCount - selectedStats.consolidation.sourceEntryCount}{' '}
                        new pending
                      </span>
                    )}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      if (consolidatedContent === null) {
                        loadConsolidated(selectedRole);
                      } else {
                        setConsolidatedContent(null);
                      }
                    }}
                    className="ml-auto underline text-primary hover:text-primary/80"
                  >
                    {consolidatedContent === null ? 'View' : 'Hide'}
                  </button>
                </div>
              )}
              {/* Consolidated content display */}
              {consolidatedContent !== null && (
                <div className="mt-2 max-h-72 overflow-y-auto rounded border border-border/50 bg-background/50 p-2">
                  <div className="text-[10px] text-muted-foreground mb-1 font-medium">
                    Consolidated knowledge for {selectedRole}
                  </div>
                  <pre className="text-[10px] whitespace-pre-wrap font-sans leading-relaxed">
                    {consolidatedContent || '(empty)'}
                  </pre>
                </div>
              )}
            </div>

            {/* Review entries */}
            {selectedStats.entryCount > 0 && (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => loadEntries(selectedRole)}
                    disabled={loadingEntries}
                    className="inline-flex items-center gap-1 rounded border border-border/50 px-3 py-1.5 text-xs hover:bg-accent transition-colors"
                  >
                    {loadingEntries ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Bookmark className="h-3 w-3" />
                    )}
                    Review Learned Entries ({selectedStats.entryCount})
                  </button>
                </div>

                {/* Entry review UI */}
                {reviewEntries && (
                  <div className="space-y-2 border border-border rounded-lg p-3 bg-card">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium">
                        {reviewEntries.filter((_, i) => reviewDecisions[i] !== 'drop').length}/
                        {reviewEntries.length} kept
                      </span>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={applyReview}
                          disabled={saving}
                          className="inline-flex items-center gap-1 rounded bg-primary px-2 py-1 text-[10px] text-primary-foreground hover:bg-primary/90 transition-colors"
                        >
                          {saving ? 'Applying…' : 'Apply Selection'}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setReviewEntries(null);
                            setReviewDecisions({});
                          }}
                          className="inline-flex items-center gap-1 rounded border border-border/50 px-2 py-1 text-[10px] hover:bg-accent transition-colors"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                    <div className="max-h-72 overflow-y-auto space-y-2">
                      {reviewEntries.map((entry, i) => {
                        const decision = reviewDecisions[i] ?? 'keep';
                        const preview = entry.length > 200 ? entry.slice(0, 200) + '…' : entry;
                        return (
                          <div
                            key={i}
                            className={cn(
                              'rounded-lg border p-2 transition-colors',
                              decision === 'drop'
                                ? 'border-destructive/40 bg-destructive/5 opacity-60'
                                : 'border-border',
                            )}
                          >
                            <div className="flex items-start justify-between gap-2">
                              <pre className="text-[10px] whitespace-pre-wrap flex-1 leading-relaxed font-sans">
                                {preview}
                              </pre>
                              <div className="flex gap-1 shrink-0">
                                <button
                                  type="button"
                                  onClick={() => setReviewDecisions((p) => ({ ...p, [i]: 'keep' }))}
                                  className={cn(
                                    'px-2 py-1 text-[9px] rounded',
                                    decision === 'keep'
                                      ? 'bg-success/20 text-success'
                                      : 'bg-muted text-muted-foreground',
                                  )}
                                >
                                  Keep
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setReviewDecisions((p) => ({ ...p, [i]: 'drop' }))}
                                  className={cn(
                                    'px-2 py-1 text-[9px] rounded',
                                    decision === 'drop'
                                      ? 'bg-destructive/20 text-destructive'
                                      : 'bg-muted text-muted-foreground',
                                  )}
                                >
                                  Drop
                                </button>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Teach section */}
            <div className="space-y-2 pt-4 border-t border-border">
              <div className="flex items-center gap-1 text-sm font-medium">
                <BookOpen className="h-4 w-4 text-brand-2" /> Teach this agent
              </div>
              <p className="text-[10px] text-muted-foreground">
                Describe a command, pattern, or behavior you want this agent to remember.
              </p>
              <textarea
                className="w-full h-20 text-xs p-2 bg-card border border-border rounded resize-y"
                value={teachInput}
                onChange={(e) => setTeachInput(e.target.value)}
                placeholder="e.g. Always use pnpm for this project"
              />
              <div className="flex justify-between items-center">
                <button
                  type="button"
                  onClick={runTeach}
                  disabled={!teachInput.trim() || saving}
                  className="inline-flex items-center gap-1 rounded bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
                >
                  <BookOpen className="h-3.5 w-3.5" /> Teach
                </button>
                {teachFeedback && (
                  <span
                    className={cn(
                      'text-xs',
                      teachFeedback.ok ? 'text-success' : 'text-destructive',
                    )}
                  >
                    {teachFeedback.msg}
                  </span>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

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
      setEditError(error instanceof Error ? error.message : 'Failed to load customization');
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
      setEditError(error instanceof Error ? error.message : 'Failed to load runtime policy');
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
        setEditError(error instanceof Error ? error.message : 'Runtime policy save failed');
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
      setEditError(error instanceof Error ? error.message : 'Save failed');
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
      setEditError(error instanceof Error ? error.message : 'LLM improvement failed');
    }
  }, [selectedRole]);

  const runReset = useCallback(
    async (role: string) => {
      if (!window.confirm(`Reset all project-specific data for agent "${role}"?`)) return;
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
      setEditError(error instanceof Error ? error.message : 'Agent creation failed');
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
              Project Agents
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
              + Clone
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
              No customizations yet
            </div>
          )}
        </div>
      </div>

      {/* Editor */}
      <div className="flex-1 min-w-0 overflow-y-auto p-4">
        {createOpen && (
          <div className="max-w-2xl space-y-4">
            <div>
              <h3 className="text-base font-semibold">Create or Clone Project Agent</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                Inherit any roster agent as a template, then develop an independent identity,
                runtime policy and learned history.
              </p>
            </div>
            <label className="block space-y-1 text-xs">
              <span className="font-medium">Clone from roster role</span>
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
                Prompt, tools, skills and defaults are inherited. Learning and later edits remain
                isolated to the new agent.
              </p>
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1 text-xs">
                <span className="font-medium">Display name</span>
                <input
                  value={createDraft.name}
                  onChange={(event) =>
                    setCreateDraft((draft) => ({ ...draft, name: event.target.value }))
                  }
                  placeholder="ABC"
                  className="h-9 w-full rounded border border-border bg-card px-2"
                />
              </label>
              <label className="space-y-1 text-xs">
                <span className="font-medium">Role id (optional)</span>
                <input
                  value={createDraft.role}
                  onChange={(event) =>
                    setCreateDraft((draft) => ({ ...draft, role: event.target.value }))
                  }
                  placeholder="abc (generated from name)"
                  className="h-9 w-full rounded border border-border bg-card px-2 font-mono"
                />
              </label>
            </div>
            <label className="block space-y-1 text-xs">
              <span className="font-medium">Purpose</span>
              <textarea
                value={createDraft.purpose}
                onChange={(event) =>
                  setCreateDraft((draft) => ({ ...draft, purpose: event.target.value }))
                }
                placeholder="Own X, Y and Z workflows for this project and verify their results."
                className="h-24 w-full resize-y rounded border border-border bg-card p-2"
              />
            </label>
            <label className="block space-y-1 text-xs">
              <span className="font-medium">Task types (comma or one per line)</span>
              <textarea
                value={createDraft.taskTypes}
                onChange={(event) =>
                  setCreateDraft((draft) => ({ ...draft, taskTypes: event.target.value }))
                }
                placeholder={'X workflow\nY analysis\nZ verification'}
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
                {saving ? 'Creating…' : 'Clone Agent'}
              </button>
              <button
                type="button"
                onClick={() => setCreateOpen(false)}
                className="rounded border border-border px-3 py-1.5 text-xs hover:bg-accent"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
        {!createOpen && !selectedRole && (
          <div className="flex items-center justify-center h-full text-muted-foreground">
            Select an agent to edit customizations
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
                  <Sparkles className="h-3 w-3 text-brand-2" /> LLM Improve
                </button>
                <button
                  type="button"
                  onClick={() => runReset(selectedRole)}
                  className="inline-flex items-center gap-1 rounded border border-destructive/30 px-2 py-1 text-[10px] text-destructive hover:bg-destructive/10 transition-colors"
                >
                  <Trash2 className="h-3 w-3" /> Reset
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
                <FileText className="h-3.5 w-3.5" /> Edit identity.md
              </button>
              <button
                type="button"
                onClick={() => startEdit(selectedRole, 'learned')}
                className="inline-flex items-center gap-1 rounded border border-border/50 px-3 py-1.5 text-xs hover:bg-accent transition-colors"
              >
                <Bookmark className="h-3.5 w-3.5" /> Edit learned.md
              </button>
              <button
                type="button"
                onClick={() => startRuntimeEdit(selectedRole)}
                className="inline-flex items-center gap-1 rounded border border-primary/40 bg-primary/5 px-3 py-1.5 text-xs text-primary hover:bg-primary/10 transition-colors"
              >
                <ShieldCheck className="h-3.5 w-3.5" /> Runtime policy
              </button>
              <button
                type="button"
                onClick={() => startEdit(selectedRole, 'config')}
                className="inline-flex items-center gap-1 rounded border border-border/50 px-3 py-1.5 text-xs hover:bg-accent transition-colors"
              >
                <Settings className="h-3.5 w-3.5" /> Edit config.json
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
                      {saving ? 'Saving…' : 'Save'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditMode(null)}
                      className="inline-flex items-center gap-1 rounded border border-border/50 px-3 py-1.5 text-xs hover:bg-accent transition-colors"
                    >
                      Cancel
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

export function AgentRosterView({ className }: { className?: string | undefined }) {
  const [activeTab, setActiveTab] = useState<RosterTab>('live');
  const [nowTick, setNowTick] = useState(Date.now());
  const [customStats, setCustomStats] = useState<CustomRosterStats[]>([]);
  const [catalog, setCatalog] = useState<RosterAgentEntry[]>(KNOWN_ROLES);
  const [rosterLoading, setRosterLoading] = useState(false);
  const [rosterError, setRosterError] = useState<string | null>(null);

  // Live clock for elapsed display
  useEffect(() => {
    const id = setInterval(() => {
      if (!document.hidden) setNowTick(Date.now());
    }, 2000);
    return () => clearInterval(id);
  }, []);

  // Load roster data from server
  const loadRoster = useCallback(async () => {
    setRosterLoading(true);
    setRosterError(null);
    try {
      const data = (await sendRosterMessage('agent-roster.list', {})) as {
        roles: string[];
        stats: CustomRosterStats[];
        catalog?: RosterAgentEntry[];
      };
      if (data.stats) setCustomStats(data.stats);
      if (data.catalog?.length) setCatalog(data.catalog);
    } catch (err) {
      setRosterError(err instanceof Error ? err.message : 'Failed to load roster');
    }
    setRosterLoading(false);
  }, []);

  useEffect(() => {
    loadRoster();
  }, [loadRoster]);

  // Refresh the roster when another client (or a background headless
  // consolidation) reports an update — no manual reload needed. Bursts of
  // updates (e.g. a bulk optimize that emits one event per role) are coalesced
  // into a single reload via a short trailing debounce.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsub = getWSClient().on('agent-roster.updated', () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        loadRoster();
      }, ROSTER_UPDATE_DEBOUNCE_MS);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsub();
    };
  }, [loadRoster]);

  return (
    <div className={cn('flex h-full min-h-0 min-w-0 w-full flex-col overflow-hidden', className)}>
      {/* ── Header bar ── */}
      <div className="shrink-0 border-b border-border/70 bg-card/80 px-4 py-2.5">
        <div className="flex items-center justify-between gap-2 flex-nowrap min-w-0">
          <div className="flex items-center gap-3 min-w-0 overflow-hidden">
            <div className="flex items-center justify-center w-8 h-8 shrink-0 rounded-lg bg-primary/10">
              <Library className="h-4 w-4 text-primary" />
            </div>
            <div className="min-w-0 overflow-hidden">
              <h1 className="text-sm font-semibold truncate">Agent Roster</h1>
              <p className="text-[10px] text-muted-foreground truncate">
                {
                  customStats.filter(
                    (s) => s.exists || s.hasIdentity || s.hasConfig || s.hasKnowledge,
                  ).length
                }{' '}
                customized · {customStats.reduce((sum, s) => sum + s.entryCount, 0)} learned entries
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {rosterLoading && (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground shrink-0" />
            )}
            <button
              type="button"
              onClick={loadRoster}
              className="inline-flex items-center gap-1 rounded border border-border/50 px-2 py-1 text-[10px] hover:bg-accent transition-colors shrink-0 whitespace-nowrap"
              title="Refresh roster data"
            >
              <RefreshCw className="h-3 w-3" /> Refresh
            </button>
          </div>
        </div>
      </div>

      {/* ── Tab bar ── */}
      <div className="shrink-0 border-b border-border/50 bg-muted/20 px-3 flex gap-0">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
            className={cn(
              'flex items-center gap-1.5 px-3 py-2 text-[10px] font-medium border-b-2 transition-colors',
              activeTab === tab.id
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground hover:border-muted-foreground/30',
            )}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      {/* ── Tab content ── */}
      <div className="flex min-h-0 min-w-0 w-full flex-1 overflow-hidden bg-background/50">
        {rosterError && (
          <div className="flex items-center justify-center w-full text-destructive text-xs gap-2">
            <AlertTriangle className="h-4 w-4" />
            {rosterError}
            <button type="button" onClick={loadRoster} className="underline">
              Retry
            </button>
          </div>
        )}

        {activeTab === 'live' && <LiveFleetTab nowTick={nowTick} />}
        {activeTab === 'catalog' && (
          <RosterCatalogTab customStats={customStats} catalog={catalog} />
        )}
        {activeTab === 'learning' && (
          <SelfLearningTab customStats={customStats} onRefresh={loadRoster} />
        )}
        {activeTab === 'customize' && (
          <CustomizationTab customStats={customStats} catalog={catalog} onRefresh={loadRoster} />
        )}
      </div>
    </div>
  );
}
