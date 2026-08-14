import { useCallback, useMemo, useState } from 'react';
import { toast } from '@/components/Toaster';
import { useAppTranslation } from '@/i18n';
import { sendRosterMessage } from '@/lib/roster-ws';
import { getWSClient } from '@/lib/ws-client';
import { useChatStore, useUIStore } from '@/stores';
import type { CustomRosterStats } from '../agent-roster-data.js';
import type { AutoOptimizeStatus, RetiredDirective, RoleSkill } from './types.js';

export function useSelfLearningState({
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
  const [retired, setRetired] = useState<RetiredDirective[] | null>(null);
  const [showRetired, setShowRetired] = useState(false);
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
      setTeachFeedback({
        ok: false,
        msg: err instanceof Error ? err.message : t('activity:agentRoster.failed'),
      });
    }
    setSaving(false);
  }, [onRefresh, selectedRole, teachInput, t]);

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
          msg:
            error instanceof Error ? error.message : t('activity:agentRoster.policyUpdateFailed'),
        });
      } finally {
        setSaving(false);
      }
    },
    [onRefresh, t],
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

  const loadRetired = useCallback(async (role: string) => {
    try {
      const data = (await sendRosterMessage('agent-roster.quarantine', { role })) as {
        retired?: RetiredDirective[];
      };
      setRetired(data.retired ?? []);
    } catch {
      setRetired([]);
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

        if (data.consolidated) {
          await onRefresh();
          await loadConsolidated(role);
          await loadSkills(role);
          await loadAutoStatus(role);
          await loadRetired(role);
          setTeachFeedback({ ok: true, msg: t('activity:agentRoster.optimizedOk') });
          toast.success(
            data.model
              ? t('activity:agentRoster.consolidatedWithModel', { model: data.model })
              : t('activity:agentRoster.consolidatedPlain'),
          );
          return;
        }

        if (data.emptySynthesis) {
          setTeachFeedback({
            ok: false,
            msg: t('activity:agentRoster.emptySynthesis'),
          });
          toast.error(t('activity:agentRoster.optimizationEmptyToast'));
          return;
        }

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
        toast.error(
          err instanceof Error ? err.message : t('activity:agentRoster.optimizationFailed'),
        );
      } finally {
        setOptimizing(false);
      }
    },
    [onRefresh, loadConsolidated, loadSkills, loadAutoStatus, loadRetired, t],
  );

  const runBulkOptimize = useCallback(
    async (roles: string[]) => {
      if (roles.length === 0) return;
      setBulkOptimizing(true);
      setTeachFeedback(null);
      try {
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
              consolidatedRoles.push(r);
            } else if (data.rawEntryCount === 0) {
              skippedCount++;
            } else if (data.emptySynthesis) {
              failedCount++;
              lastErrorMsg = 'Model returned an empty result';
            } else if (data.instruction) {
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

        if (selectedRole && consolidatedRoles.includes(selectedRole)) {
          await loadConsolidated(selectedRole);
        }

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

        if (consolidatedRoles.length === 0 && fallback.length === 0) {
          if (failedCount > 0) {
            const skipSuffix = skippedCount > 0 ? ` ${skippedCount} skipped.` : '';
            const diagnostic = `Bulk consolidate failed for ${failedCount} of ${roles.length} agent${roles.length > 1 ? 's' : ''}.${lastErrorMsg ? ` Last error: ${lastErrorMsg}` : ''}${skipSuffix}`;
            setTeachFeedback({ ok: false, msg: diagnostic });
            return;
          }
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
          msg:
            err instanceof Error ? err.message : t('activity:agentRoster.bulkOptimizationFailed'),
        });
        toast.error(
          err instanceof Error ? err.message : t('activity:agentRoster.bulkOptimizationFailed'),
        );
      } finally {
        setBulkOptimizing(false);
      }
    },
    [selectedRole, loadConsolidated, t],
  );

  const selectRole = useCallback(
    (role: string) => {
      setSelectedRole(role);
      setReviewEntries(null);
      setConsolidatedContent(null);
      setOpenSkill(null);
      setRetired(null);
      setShowRetired(false);
      void loadSkills(role);
      void loadAutoStatus(role);
      void loadRetired(role);
    },
    [loadSkills, loadAutoStatus, loadRetired],
  );

  return {
    selectedRole,
    reviewEntries,
    setReviewEntries,
    reviewDecisions,
    setReviewDecisions,
    teachInput,
    setTeachInput,
    teachFeedback,
    saving,
    loadingEntries,
    consolidatedContent,
    setConsolidatedContent,
    optimizing,
    bulkOptimizing,
    skills,
    retired,
    showRetired,
    setShowRetired,
    autoStatus,
    openSkill,
    populated,
    selectedStats,
    loadEntries,
    applyReview,
    runTeach,
    setLearningEnabled,
    toggleSkillBody,
    toggleSkillPin,
    loadConsolidated,
    runOptimize,
    runBulkOptimize,
    selectRole,
  };
}
