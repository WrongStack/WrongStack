/**
 * CustomRosterPanel — WebUI panel for monitoring and editing project-custom
 * roster agents (.wrongstack/agents/<role>/ identity.md, learned.md, config.json).
 *
 * Shows ONLY roles that have been customized (have any of identity.md,
 * learned.md, config.json, or knowledge.json).
 *
 * Features:
 * - Stats table per role (entry count, size, last capture, cooldown, conflicts)
 * - Inline markdown editors for identity.md and learned.md
 * - Inline JSON editor for config.json
 * - LLM-assisted improvement: free-text prompt → suggested changes
 * - Refresh / reset / capture actions
 * - Conflict detection display
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Bot,
  FileText,
  RefreshCw,
  Settings,
  Sparkles,
  Trash2,
  AlertTriangle,
  Database,
  BookOpen,
} from 'lucide-react';
import { useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';

// ─── Types (mirror of ProjectAgentLearnStats from project-agent-identity.ts) ──

export interface ProjectAgentLearnStats {
  role: string;
  exists: boolean;
  entryCount: number;
  totalBytes: number;
  lastCapture: string | null;
  cooldownRemainingMs: number;
  sessionCaptureCount: number;
  needsSummarization: boolean;
  hasIdentity: boolean;
  hasConfig: boolean;
  hasKnowledge: boolean;
  conflictCount?: number;
  sharedLearnedExists?: boolean;
  sharedIdentityExists?: boolean;
}

// ─── Helper: send WS message and wait for response ──────────────────────────

let wsRef: WebSocket | null = null;

function setCustomRosterWS(ws: WebSocket | null): void {
  wsRef = ws;
}

function sendRosterMessage(type: string, payload?: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const ws = wsRef;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      reject(new Error('WebSocket not connected'));
      return;
    }
    const _msgId = `roster-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;

    const handler = (event: MessageEvent) => {
      if (settled) return;
      try {
        const data = JSON.parse(event.data as string);
        if (data.type === type || data.type === `agent-roster.${type.split('.').pop()}`) {
          settled = true;
          if (timer) clearTimeout(timer);
          ws.removeEventListener('message', handler);
          resolve(data.payload ?? data);
        }
      } catch {
        /* non-JSON message, skip */
      }
    };

    // Timeout safety
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      ws.removeEventListener('message', handler);
      reject(new Error(`Roster request "${type}" timed out`));
    }, 15_000);

    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({ type, payload }));
  });
}

// ─── Panel component ────────────────────────────────────────────────────────

interface CustomRosterPanelProps {
  projectRoot?: string;
}

export function CustomRosterPanel({ projectRoot }: CustomRosterPanelProps) {
  const { t } = useAppTranslation();
  const [roles, setRoles] = useState<ProjectAgentLearnStats[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedRole, setSelectedRole] = useState<string | null>(null);
  const [editMode, setEditMode] = useState<'identity' | 'learned' | 'config' | null>(null);
  const [editContent, setEditContent] = useState('');
  const [improvePrompt, setImprovePrompt] = useState('');
  const [improveResult, setImproveResult] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [teachInput, setTeachInput] = useState('');
  const [teachFeedback, setTeachFeedback] = useState<{ ok: boolean; msg: string } | null>(null);
  const [reviewEntries, setReviewEntries] = useState<string[] | null>(null);
  const [reviewDecisions, setReviewDecisions] = useState<Record<number, 'keep' | 'drop'>>({});
  const [reviewBusy, setReviewBusy] = useState(false);
  const [conflicts, setConflicts] = useState<
    Array<{ roleA: string; roleB: string; similarity: number }>
  >([]);

  // ── Load roster data ──────────────────────────────────────────────────
  const loadRoster = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = (await sendRosterMessage('agent-roster.list', { projectRoot })) as {
        roles: string[];
        stats: ProjectAgentLearnStats[];
      };
      setRoles(data.stats ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('activity:customRoster.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [projectRoot]);

  const loadConflicts = useCallback(async () => {
    try {
      const data = (await sendRosterMessage('agent-roster.conflicts', { projectRoot })) as {
        conflicts: Array<{ roleA: string; roleB: string; similarity: number }>;
      };
      setConflicts(data.conflicts ?? []);
    } catch {
      /* non-critical */
    }
  }, [projectRoot]);

  useEffect(() => {
    loadRoster();
    loadConflicts();
  }, [loadRoster, loadConflicts]);

  // ── Select role and load its data ─────────────────────────────────────
  const selectedStats = useMemo(
    () => roles.find((r) => r.role === selectedRole),
    [roles, selectedRole],
  );

  // ── Start editing a file ──────────────────────────────────────────────
  const startEdit = async (role: string, mode: 'identity' | 'learned' | 'config') => {
    setEditMode(mode);
    setEditContent('');
    setImproveResult(null);
    setSelectedRole(role);
    try {
      const data = (await sendRosterMessage('agent-roster.stats', {
        role,
        projectRoot,
      })) as ProjectAgentLearnStats;
      setRoles((prev) => prev.map((r) => (r.role === role ? { ...r, ...data } : r)));
    } catch {
      /* use cached data */
    }
  };

  // ── Save edit ─────────────────────────────────────────────────────────
  const saveEdit = async () => {
    if (!selectedRole || !editMode) return;
    setSaving(true);
    try {
      const typeMap: Record<string, string> = {
        identity: 'agent-roster.update-identity',
        learned: 'agent-roster.update-learned',
        config: 'agent-roster.update-config',
      };
      const payload: Record<string, unknown> = { role: selectedRole, projectRoot };
      if (editMode === 'config') {
        try {
          payload.config = JSON.parse(editContent);
        } catch {
          throw new Error(t('activity:customRoster.invalidJson'));
        }
      } else {
        payload.content = editContent;
      }
      await sendRosterMessage(typeMap[editMode], payload);
      setEditMode(null);
      loadRoster();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('activity:agentRoster.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  // ── LLM improve ──────────────────────────────────────────────────────
  const runImprove = async () => {
    if (!selectedRole || !improvePrompt.trim()) return;
    setImproveResult(null);
    try {
      const data = (await sendRosterMessage('agent-roster.llm-improve', {
        role: selectedRole,
        prompt: improvePrompt,
        projectRoot,
      })) as { instruction: string };
      setImproveResult(data.instruction ?? t('activity:customRoster.noImprovement'));
    } catch (err) {
      setImproveResult(
        err instanceof Error ? err.message : t('activity:customRoster.improveFailed'),
      );
    }
  };

  // ── Teach this agent ─────────────────────────────────────────────────
  const runTeach = async () => {
    if (!selectedRole || !teachInput.trim()) return;
    setTeachFeedback(null);
    setSaving(true);
    try {
      const content = `> Taught ${new Date().toISOString().slice(0, 10)}\n\n${teachInput.trim()}`;
      const data = (await sendRosterMessage('agent-roster.append-learned', {
        role: selectedRole,
        content,
        projectRoot,
      })) as { success: boolean; path: string };
      if (data.success) {
        setTeachFeedback({ ok: true, msg: t('activity:customRoster.behaviorSaved') });
        setTeachInput('');
        loadRoster();
      } else {
        setTeachFeedback({ ok: false, msg: t('activity:customRoster.saveFailedServer') });
      }
    } catch (err) {
      setTeachFeedback({
        ok: false,
        msg: err instanceof Error ? err.message : t('activity:agentRoster.teachFailed'),
      });
    } finally {
      setSaving(false);
    }
  };

  // ── Review learned entries ───────────────────────────────────────────
  const loadReviewEntries = async (role: string) => {
    try {
      const data = (await sendRosterMessage('agent-roster.read-learned', {
        role,
        projectRoot,
      })) as { entries: string[] };
      setReviewEntries(data.entries ?? []);
      setReviewDecisions({});
      setReviewBusy(false);
    } catch {
      /* ignore */
    }
  };

  const applyReview = async () => {
    if (!selectedRole || !reviewEntries) return;
    setReviewBusy(true);
    const kept = reviewEntries.filter((_, i) => reviewDecisions[i] !== 'drop');
    const content = kept.join('\n\n---\n\n');
    try {
      await sendRosterMessage('agent-roster.update-learned', {
        role: selectedRole,
        content,
        projectRoot,
      });
      setReviewEntries(null);
      setReviewDecisions({});
      loadRoster();
    } catch {
      /* ignore */
    }
    setReviewBusy(false);
  };

  // ── Capture learned ──────────────────────────────────────────────────
  const runCapture = async (role: string) => {
    try {
      const _data = (await sendRosterMessage('agent-roster.capture', { role, projectRoot })) as {
        captured: number;
      };
      loadRoster();
    } catch {
      /* ignore */
    }
  };

  // ── Reset role ────────────────────────────────────────────────────────
  const runReset = async (role: string) => {
    try {
      await sendRosterMessage('agent-roster.reset', { role, projectRoot });
      setSelectedRole(null);
      loadRoster();
    } catch {
      /* ignore */
    }
  };

  // ── Render ────────────────────────────────────────────────────────────

  if (error) {
    return (
      <div className="flex items-center justify-center h-full text-destructive">
        <AlertTriangle className="h-4 w-4 mr-2" />
        {error}
        <button type="button" onClick={loadRoster} className="ml-2 underline">
          {t('common:action.retry')}
        </button>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
        {t('activity:customRoster.loading')}
      </div>
    );
  }

  if (roles.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-4 p-8">
        <Bot className="h-12 w-12 opacity-30" />
        <p className="text-lg font-medium">{t('activity:customRoster.emptyTitle')}</p>
        <p className="text-sm text-center max-w-md">
          {t('activity:customRoster.emptyBody')}
          <code className="block mt-1 text-xs bg-muted px-2 py-1 rounded">
            .wrongstack/agents/&lt;role&gt;/
          </code>
        </p>
        <button
          type="button"
          onClick={() => {
            startEdit('executor', 'identity');
            setSelectedRole('executor');
          }}
          className="text-sm text-primary hover:underline mt-2"
        >
          {t('activity:customRoster.createExecutorIdentity')}
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full">
      {/* ── Role list sidebar ── */}
      <div className="w-64 border-r border-line shrink-0 overflow-y-auto">
        <div className="p-3 border-b border-line flex items-center justify-between">
          <h2 className="text-sm font-semibold">{t('activity:customRoster.heading')}</h2>
          <button type="button" onClick={loadRoster} className="p-1 hover:bg-accent rounded">
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>
        {roles.map((r) => (
          <button
            key={r.role}
            type="button"
            onClick={() => setSelectedRole(r.role)}
            className={cn(
              'w-full text-left px-3 py-2 text-xs border-b border-line/50 hover:bg-accent/50 transition-colors',
              selectedRole === r.role && 'bg-primary/10 border-l-2 border-l-primary',
            )}
          >
            <div className="flex items-center justify-between">
              <span className="font-medium">{r.role}</span>
              <span className="text-[10px] text-muted-foreground">{r.totalBytes}B</span>
            </div>
            <div className="flex gap-2 text-[10px] text-muted-foreground mt-0.5">
              {r.hasIdentity && (
                <span className="flex items-center gap-0.5">
                  <FileText className="h-3 w-3" />
                  id
                </span>
              )}
              {r.entryCount > 0 && (
                <span className="flex items-center gap-0.5">
                  <Database className="h-3 w-3" />
                  {r.entryCount}e
                </span>
              )}
              {r.needsSummarization && <span className="text-warning">⚠</span>}
              {r.sessionCaptureCount > 0 && (
                <span className="text-brand-2">+{r.sessionCaptureCount}</span>
              )}
            </div>
          </button>
        ))}
      </div>

      {/* ── Detail panel ── */}
      <div className="flex-1 min-h-0 overflow-y-auto p-4">
        {!selectedRole && (
          <div className="flex items-center justify-center h-full text-muted-foreground">
            {t('activity:agentRoster.selectRoleEmpty')}
          </div>
        )}
        {selectedRole && selectedStats && (
          <div className="space-y-4">
            {/* Header */}
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold">{selectedRole}</h3>
              <div className="flex gap-1">
                <button
                  type="button"
                  onClick={() => runCapture(selectedRole)}
                  className="btn-sm"
                  title={t('activity:agentRoster.captureLearned')}
                >
                  <Database className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => runReset(selectedRole)}
                  className="btn-sm text-destructive"
                  title={t('common:action.reset')}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            {/* Stats bar */}
            <div className="grid grid-cols-4 gap-3 text-xs">
              <div className="bg-card rounded-lg p-2 border border-line">
                <div className="text-muted-foreground">{t('activity:customRoster.entries')}</div>
                <div className="text-lg font-semibold">{selectedStats.entryCount}</div>
              </div>
              <div className="bg-card rounded-lg p-2 border border-line">
                <div className="text-muted-foreground">{t('activity:customRoster.size')}</div>
                <div className="text-lg font-semibold">{selectedStats.totalBytes}B</div>
              </div>
              <div className="bg-card rounded-lg p-2 border border-line">
                <div className="text-muted-foreground">{t('activity:agentRoster.lastCapture')}</div>
                <div className="text-lg font-semibold">
                  {selectedStats.lastCapture
                    ? new Date(selectedStats.lastCapture).toLocaleDateString()
                    : '—'}
                </div>
              </div>
              <div className="bg-card rounded-lg p-2 border border-line">
                <div className="text-muted-foreground">
                  {t('activity:customRoster.sessionCaptures')}
                </div>
                <div className="text-lg font-semibold">{selectedStats.sessionCaptureCount}/3</div>
              </div>
            </div>

            {/* Warning banner */}
            {selectedStats.needsSummarization && (
              <div className="flex items-center gap-2 text-xs text-warning bg-warning/10 rounded-lg px-3 py-2">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                learned.md exceeds soft limit ({selectedStats.totalBytes}B / 8192B). Run
                /agent-improve {selectedRole} refresh or summarize manually.
              </div>
            )}

            {/* Conflicts */}
            {conflicts.filter((c) => c.roleA === selectedRole || c.roleB === selectedRole).length >
              0 && (
              <div className="flex items-center gap-2 text-xs text-destructive bg-destructive/10 rounded-lg px-3 py-2">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                {
                  conflicts.filter((c) => c.roleA === selectedRole || c.roleB === selectedRole)
                    .length
                }{' '}
                conflict(s) detected
              </div>
            )}

            {/* Edit buttons */}
            <div className="flex gap-2 flex-wrap">
              <button
                type="button"
                onClick={() => startEdit(selectedRole, 'identity')}
                className="btn-sm"
              >
                <FileText className="h-3.5 w-3.5 mr-1" /> {t('activity:customRoster.editIdentity')}
              </button>
              <button
                type="button"
                onClick={() => startEdit(selectedRole, 'learned')}
                className="btn-sm"
              >
                <Database className="h-3.5 w-3.5 mr-1" /> {t('activity:customRoster.editLearned')}
              </button>
              <button
                type="button"
                onClick={() => startEdit(selectedRole, 'config')}
                className="btn-sm"
              >
                <Settings className="h-3.5 w-3.5 mr-1" /> {t('activity:customRoster.editConfig')}
              </button>
              {selectedStats.entryCount > 0 && !reviewEntries && (
                <button
                  type="button"
                  onClick={() => loadReviewEntries(selectedRole)}
                  className="btn-sm"
                >
                  <AlertTriangle className="h-3.5 w-3.5 mr-1" />{' '}
                  {t('activity:customRoster.reviewEntries', { count: selectedStats.entryCount })}
                </button>
              )}
            </div>

            {/* Review learned entries */}
            {reviewEntries && reviewEntries.length > 0 && (
              <div className="space-y-2 border border-line rounded-lg p-3 bg-card">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">
                    {t('activity:customRoster.reviewLearnedEntries', {
                      kept: reviewEntries.filter((_, i) => reviewDecisions[i] !== 'drop').length,
                      total: reviewEntries.length,
                    })}
                  </span>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={applyReview}
                      disabled={reviewBusy}
                      className="btn-sm btn-primary"
                    >
                      {reviewBusy
                        ? t('activity:agentRoster.applying')
                        : t('activity:customRoster.applySelection')}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setReviewEntries(null);
                        setReviewDecisions({});
                      }}
                      className="btn-sm"
                    >
                      {t('common:action.cancel')}
                    </button>
                  </div>
                </div>
                <div className="max-h-80 overflow-y-auto space-y-2">
                  {reviewEntries.map((entry, i) => {
                    const decision = reviewDecisions[i] ?? 'keep';
                    const preview = entry.length > 280 ? entry.slice(0, 280) + '…' : entry;
                    return (
                      <div
                        key={i}
                        className={cn(
                          'rounded-lg border p-2 transition-colors',
                          decision === 'drop'
                            ? 'border-destructive/40 bg-destructive/5 opacity-60'
                            : 'border-line',
                        )}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <pre className="text-[11px] whitespace-pre-wrap flex-1 leading-relaxed font-sans">
                            {preview}
                          </pre>
                          <div className="flex gap-1 shrink-0">
                            <button
                              type="button"
                              onClick={() => setReviewDecisions((p) => ({ ...p, [i]: 'keep' }))}
                              className={cn(
                                'px-2 py-1 text-[10px] rounded',
                                decision === 'keep'
                                  ? 'bg-success/20 text-success'
                                  : 'bg-muted text-muted-foreground',
                              )}
                            >
                              {t('activity:customRoster.keep')}
                            </button>
                            <button
                              type="button"
                              onClick={() => setReviewDecisions((p) => ({ ...p, [i]: 'drop' }))}
                              className={cn(
                                'px-2 py-1 text-[10px] rounded',
                                decision === 'drop'
                                  ? 'bg-destructive/20 text-destructive'
                                  : 'bg-muted text-muted-foreground',
                              )}
                            >
                              {t('activity:customRoster.drop')}
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
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
                      className="btn-sm btn-primary"
                    >
                      {saving ? t('activity:agentRoster.saving') : t('common:action.save')}
                    </button>
                    <button type="button" onClick={() => setEditMode(null)} className="btn-sm">
                      {t('common:action.cancel')}
                    </button>
                  </div>
                </div>
                {editMode === 'config' ? (
                  <textarea
                    className="w-full h-48 font-mono text-xs p-2 bg-card border border-line rounded resize-y"
                    value={editContent}
                    onChange={(e) => setEditContent(e.target.value)}
                    placeholder='{ "tools": [...], "budget": {...} }'
                  />
                ) : (
                  <textarea
                    className="w-full h-48 font-mono text-xs p-2 bg-card border border-line rounded resize-y"
                    value={editContent}
                    onChange={(e) => setEditContent(e.target.value)}
                    placeholder={t('activity:customRoster.identityPlaceholder', {
                      role: selectedRole,
                    })}
                  />
                )}
              </div>
            )}

            {/* Teach this agent */}
            <div className="space-y-2 pt-4 border-t border-line">
              <div className="flex items-center gap-1 text-sm font-medium">
                <BookOpen className="h-4 w-4 text-brand-2" />
                {t('activity:agentRoster.teachThisAgent')}
              </div>
              <p className="text-[10px] text-muted-foreground">
                {t('activity:customRoster.teachHint')}{' '}
                <code className="text-[10px]">.wrongstack/agents/{selectedRole}/learned.md</code>.
              </p>
              <textarea
                className="w-full h-20 text-xs p-2 bg-card border border-line rounded resize-y"
                value={teachInput}
                onChange={(e) => setTeachInput(e.target.value)}
                placeholder={t('activity:customRoster.teachInputPlaceholder')}
              />
              <div className="flex justify-between items-center">
                <button
                  type="button"
                  onClick={runTeach}
                  disabled={!teachInput.trim() || saving}
                  className="btn-sm btn-primary"
                >
                  <BookOpen className="h-3.5 w-3.5 mr-1" /> {t('activity:customRoster.teach')}
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

            {/* LLM Improve */}
            <div className="space-y-2 pt-4 border-t border-line">
              <div className="flex items-center gap-1 text-sm font-medium">
                <Sparkles className="h-4 w-4 text-brand-2" />
                {t('activity:customRoster.llmImprove')}
              </div>
              <textarea
                className="w-full h-20 text-xs p-2 bg-card border border-line rounded resize-y"
                value={improvePrompt}
                onChange={(e) => setImprovePrompt(e.target.value)}
                placeholder={t('activity:agentRoster.teachPlaceholder')}
              />
              <div className="flex justify-between items-center">
                <button
                  type="button"
                  onClick={runImprove}
                  disabled={!improvePrompt.trim()}
                  className="btn-sm btn-primary"
                >
                  <Sparkles className="h-3.5 w-3.5 mr-1" /> {t('activity:customRoster.improve')}
                </button>
                {improveResult && (
                  <button
                    type="button"
                    onClick={() => setImproveResult(null)}
                    className="text-xs text-muted-foreground hover:text-fg"
                  >
                    {t('activity:customRoster.dismiss')}
                  </button>
                )}
              </div>
              {improveResult && (
                <div className="text-xs bg-accent/30 rounded-lg p-3 whitespace-pre-wrap max-h-48 overflow-y-auto">
                  {improveResult}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
