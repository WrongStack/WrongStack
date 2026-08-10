import {
  AlertTriangle,
  Bookmark,
  BookOpen,
  CheckCircle2,
  Database,
  Loader2,
  Sparkles,
  Zap,
} from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { toast } from '@/components/Toaster';
import { useAppTranslation } from '@/i18n';
import { sendRosterMessage } from '@/lib/roster-ws';
import { cn } from '@/lib/utils';
import { getWSClient } from '@/lib/ws-client';
import { useChatStore, useUIStore } from '@/stores';
import type { CustomRosterStats } from './agent-roster-data.js';

/** Whether the background scheduler considers a role due for distillation. */
interface AutoOptimizeStatus {
  enabled: boolean;
  eligible: boolean;
  reason: string;
}

/** Human wording for the scheduler's decision. */
const AUTO_REASON_LABEL: Record<string, string> = {
  size: 'buffer reached the size threshold',
  'pending-skills': 'directives are waiting to reach their skill',
  disabled: 'auto-optimization is off',
  'learning-paused': 'learning is paused for this agent',
  'too-few-entries': 'not enough directives yet',
  'below-threshold': 'below the threshold',
  'cooling-down': 'recently optimized — cooling down',
};

/** One skill a role may draw on, with what this project has done to it. */
interface RoleSkill {
  skill: string;
  developed: boolean;
  affinity: {
    loaded: number;
    succeeded: number;
    failed: number;
    learned: number;
    pinned?: boolean;
  } | null;
}

export function SelfLearningTab({
  customStats,
  onRefresh,
}: {
  customStats: CustomRosterStats[];
  onRefresh: () => void;
}) {
  const { t } = useAppTranslation();
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
  const [skills, setSkills] = useState<RoleSkill[] | null>(null);
  const [autoStatus, setAutoStatus] = useState<AutoOptimizeStatus | null>(null);
  const [openSkill, setOpenSkill] = useState<{ skill: string; content: string } | null>(null);

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
        setTeachFeedback({ ok: true, msg: t('activity:customRoster.behaviorSaved') });
        setTeachInput('');
        onRefresh();
      } else {
        setTeachFeedback({ ok: false, msg: t('activity:agentRoster.saveFailed') });
      }
    } catch (err) {
      setTeachFeedback({ ok: false, msg: err instanceof Error ? err.message : t('activity:agentRoster.failed') });
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
          msg: enabled
            ? t('activity:agentRoster.learningResumed')
            : t('activity:agentRoster.autoLearningPaused'),
        });
        onRefresh();
      } catch (error) {
        setTeachFeedback({
          ok: false,
          msg: error instanceof Error ? error.message : t('activity:agentRoster.policyUpdateFailed'),
        });
      } finally {
        setSaving(false);
      }
    },
    [onRefresh],
  );

  const loadAutoStatus = useCallback(async (role: string) => {
    try {
      const data = (await sendRosterMessage('agent-roster.auto-optimize-status', { role })) as {
        policy?: { enabled?: boolean };
        roles?: Array<{ role: string; eligible: boolean; reason: string }>;
      };
      const entry = data.roles?.find((r) => r.role === role);
      setAutoStatus(
        entry
          ? {
              enabled: data.policy?.enabled !== false,
              eligible: entry.eligible,
              reason: entry.reason,
            }
          : null,
      );
    } catch {
      setAutoStatus(null);
    }
  }, []);

  // Load the role's skills and which of them this project has developed.
  const loadSkills = useCallback(async (role: string) => {
    try {
      const data = (await sendRosterMessage('agent-roster.skills', { role })) as {
        skills?: RoleSkill[];
      };
      setSkills(data.skills ?? []);
    } catch {
      setSkills([]);
    }
  }, []);

  const toggleSkillBody = useCallback(
    async (role: string, skill: string) => {
      if (openSkill?.skill === skill) {
        setOpenSkill(null);
        return;
      }
      try {
        const data = (await sendRosterMessage('agent-roster.read-skill', { role, skill })) as {
          content?: string;
        };
        setOpenSkill({ skill, content: data.content ?? '' });
      } catch {
        setOpenSkill({ skill, content: '' });
      }
    },
    [openSkill],
  );

  const toggleSkillPin = useCallback(
    async (role: string, skill: string, pinned: boolean) => {
      try {
        await sendRosterMessage('agent-roster.pin-skill', { role, skill, pinned });
        await loadSkills(role);
      } catch {
        /* ignore */
      }
    },
    [loadSkills],
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
          setTeachFeedback({ ok: false, msg: t('activity:agentRoster.noRawEntries') });
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
          await loadSkills(role);
          await loadAutoStatus(role);
          setTeachFeedback({ ok: true, msg: t('activity:agentRoster.optimizedOk') });
          toast.success(
            data.model
              ? t('activity:agentRoster.consolidatedWithModel', { model: data.model })
              : t('activity:agentRoster.consolidatedPlain'),
          );
          return;
        }

        // ── Empty synthesis: the model ran but produced nothing usable. The
        // existing document is left untouched; surface a retryable message. ──
        if (data.emptySynthesis) {
          setTeachFeedback({
            ok: false,
            msg: t('activity:agentRoster.emptySynthesis'),
          });
          toast.error(t('activity:agentRoster.optimizationEmptyToast'));
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
          msg: t('activity:agentRoster.noActiveModelMsg'),
        });
        toast.info(t('activity:agentRoster.noActiveModelToast'));
      } catch (err) {
        setTeachFeedback({
          ok: false,
          msg: err instanceof Error ? err.message : t('activity:agentRoster.optimizationFailed'),
        });
        toast.error(err instanceof Error ? err.message : t('activity:agentRoster.optimizationFailed'));
      } finally {
        setOptimizing(false);
      }
    },
    [onRefresh, loadConsolidated, loadSkills, loadAutoStatus],
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
          msg: err instanceof Error ? err.message : t('activity:agentRoster.bulkOptimizationFailed'),
        });
        toast.error(err instanceof Error ? err.message : t('activity:agentRoster.bulkOptimizationFailed'));
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
          <p className="text-sm">{t('activity:agentRoster.noSelfLearningDataYet')}</p>
          <p className="text-xs text-muted-foreground/70">
            {t('activity:agentRoster.learningsEmpty')}
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
            {t('activity:agentRoster.allRosterAgents')}
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
                        setOpenSkill(null);
                        void loadSkills(first.role);
                        void loadAutoStatus(first.role);
                      }
                    }}
                    className="ml-auto text-[9px] text-warning underline hover:text-warning/80 shrink-0"
                  >
                    {t('activity:agentRoster.review')}
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
                  {bulkOptimizing
                    ? t('activity:agentRoster.optimizing')
                    : t('activity:agentRoster.optimizeAll', { count: needsOpt.length })}
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
                setOpenSkill(null);
                void loadSkills(stat.role);
                void loadAutoStatus(stat.role);
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
                  {stat.learningEnabled
                    ? t('activity:agentRoster.learning')
                    : t('activity:agentRoster.paused')}
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
      <div className="flex-1 min-h-0 min-w-0 overflow-y-auto p-4">
        {!selectedRole && (
          <div className="flex items-center justify-center h-full text-muted-foreground">
            {t('activity:agentRoster.selectAnAgentToViewLearning')}
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
                  {selectedStats.learningEnabled
                    ? t('activity:agentRoster.learningOn')
                    : t('activity:agentRoster.learningPaused')}
                </button>
              </div>
            </div>

            {/* Stats cards */}
            <div className="grid grid-cols-4 gap-2">
              <div className="rounded-lg border bg-card p-2">
                <span className="text-[9px] text-muted-foreground uppercase tracking-wider">
                  {t('activity:agentRoster.entries')}
                </span>
                <div className="text-lg font-mono font-semibold mt-0.5">
                  {selectedStats.entryCount}
                </div>
              </div>
              <div className="rounded-lg border bg-card p-2">
                <span className="text-[9px] text-muted-foreground uppercase tracking-wider">
                  {t('activity:agentRoster.size')}
                </span>
                <div className="text-lg font-mono font-semibold mt-0.5">
                  {selectedStats.totalBytes}B
                </div>
              </div>
              <div className="rounded-lg border bg-card p-2">
                <span className="text-[9px] text-muted-foreground uppercase tracking-wider">
                  {t('activity:agentRoster.lastCapture')}
                </span>
                <div className="text-lg font-mono font-semibold mt-0.5">
                  {selectedStats.lastCapture
                    ? new Date(selectedStats.lastCapture).toLocaleDateString()
                    : '—'}
                </div>
              </div>
              <div className="rounded-lg border bg-card p-2">
                <span className="text-[9px] text-muted-foreground uppercase tracking-wider">
                  {t('activity:agentRoster.lifetimeCaptures')}
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
                  {t('activity:agentRoster.learningsLimitExceeded', { bytes: selectedStats.totalBytes.toLocaleString() })}
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
                  {optimizing ? t('activity:agentRoster.optimizing') : 'Optimize Now'}
                </button>
              </div>
            )}

            {/* Optimization / Consolidation section */}
            <div className="space-y-2 border border-border rounded-lg p-3 bg-card">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5">
                  <Sparkles className="h-4 w-4 text-primary" />
                  <span className="text-xs font-semibold">{t('activity:agentRoster.optimizeLearnings')}</span>
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
                  {optimizing ? t('activity:agentRoster.optimizing') : 'Optimize'}
                </button>
              </div>
              {autoStatus && (
                <div className="flex items-center gap-1.5 text-[10px]">
                  <span
                    className={cn(
                      'inline-block h-1.5 w-1.5 rounded-full',
                      !autoStatus.enabled
                        ? 'bg-muted-foreground'
                        : autoStatus.eligible
                          ? 'bg-warning'
                          : 'bg-success',
                    )}
                  />
                  <span className="text-muted-foreground">
                    {!autoStatus.enabled
                      ? 'Automatic optimization is off — run it manually.'
                      : autoStatus.eligible
                        ? `Queued automatically: ${AUTO_REASON_LABEL[autoStatus.reason] ?? autoStatus.reason}.`
                        : `Automatic — ${AUTO_REASON_LABEL[autoStatus.reason] ?? autoStatus.reason}.`}
                  </span>
                </div>
              )}
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
                        {t('activity:agentRoster.newPending')}
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
                    {consolidatedContent === null ? t('activity:agentRoster.viewAction') : 'Hide'}
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

            {/* Project-developed skills */}
            {skills && skills.length > 0 && (
              <div className="space-y-2 border border-border rounded-lg p-3 bg-card">
                <div className="flex items-center gap-1.5">
                  <BookOpen className="h-4 w-4 text-brand-2" />
                  <span className="text-xs font-semibold">Skills</span>
                  <span className="text-[10px] text-muted-foreground">
                    {skills.filter((s) => s.developed).length} of {skills.length} developed for this
                    project
                  </span>
                </div>
                <p className="text-[10px] text-muted-foreground leading-relaxed">
                  A developed skill carries a project addendum injected right after the bundled
                  skill body — the agent reads one skill, refined for this codebase. Pin a skill to
                  keep it loaded regardless of ranking.
                </p>
                <div className="space-y-1">
                  {skills.map((entry) => (
                    <div key={entry.skill} className="rounded border border-border/60">
                      <div className="flex items-center gap-2 px-2 py-1.5">
                        <button
                          type="button"
                          onClick={() => toggleSkillBody(selectedRole, entry.skill)}
                          disabled={!entry.developed}
                          className={cn(
                            'text-[11px] font-mono text-left flex-1 truncate',
                            entry.developed
                              ? 'text-primary hover:underline'
                              : 'text-muted-foreground cursor-default',
                          )}
                          title={
                            entry.developed
                              ? 'View the project addendum'
                              : 'No project addendum yet — capture a directive tagged with this skill, then Optimize'
                          }
                        >
                          {entry.skill}
                        </button>
                        {entry.developed && (
                          <span className="text-[9px] rounded bg-success/15 text-success px-1.5 py-0.5">
                            developed
                          </span>
                        )}
                        {entry.affinity && (
                          <span className="text-[9px] text-muted-foreground tabular-nums">
                            {entry.affinity.learned > 0 && `${entry.affinity.learned} learned · `}
                            {entry.affinity.succeeded}✓/{entry.affinity.failed}✗
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={() =>
                            toggleSkillPin(selectedRole, entry.skill, !entry.affinity?.pinned)
                          }
                          className={cn(
                            'text-[9px] rounded border px-1.5 py-0.5 transition-colors',
                            entry.affinity?.pinned
                              ? 'border-primary/50 text-primary'
                              : 'border-border/50 text-muted-foreground hover:bg-accent',
                          )}
                        >
                          {entry.affinity?.pinned ? 'pinned' : 'pin'}
                        </button>
                      </div>
                      {openSkill?.skill === entry.skill && (
                        <div className="max-h-60 overflow-y-auto border-t border-border/50 bg-background/50 p-2">
                          <pre className="text-[10px] whitespace-pre-wrap font-sans leading-relaxed">
                            {openSkill.content || '(empty)'}
                          </pre>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

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
                          {saving ? t('activity:agentRoster.applying') : 'Apply Selection'}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setReviewEntries(null);
                            setReviewDecisions({});
                          }}
                          className="inline-flex items-center gap-1 rounded border border-border/50 px-2 py-1 text-[10px] hover:bg-accent transition-colors"
                        >
                          {t('activity:agentRoster.cancel')}
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
                                  {t('activity:agentRoster.keep')}
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
                                  {t('activity:agentRoster.drop')}
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
                <BookOpen className="h-4 w-4 text-brand-2" /> {t('activity:agentRoster.teachThisAgent')}
              </div>
              <p className="text-[10px] text-muted-foreground">
                {t('activity:agentRoster.describeACommandPatternOrBehavior')}
              </p>
              <textarea
                className="w-full h-20 text-xs p-2 bg-card border border-border rounded resize-y"
                value={teachInput}
                onChange={(e) => setTeachInput(e.target.value)}
                placeholder={t('activity:agentRoster.eGAlwaysUsePnpmForThisProject')}
              />
              <div className="flex justify-between items-center">
                <button
                  type="button"
                  onClick={runTeach}
                  disabled={!teachInput.trim() || saving}
                  className="inline-flex items-center gap-1 rounded bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
                >
                  <BookOpen className="h-3.5 w-3.5" /> {t('activity:agentRoster.teach')}
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
