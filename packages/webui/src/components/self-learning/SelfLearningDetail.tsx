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
import { useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import type { CustomRosterStats } from '../agent-roster-data.js';
import {
  AUTO_REASON_LABEL,
  type AutoOptimizeStatus,
  type RetiredDirective,
  type RoleSkill,
} from './types.js';

export function SelfLearningDetail({
  selectedRole,
  selectedStats,
  saving,
  setLearningEnabled,
  optimizing,
  runOptimize,
  autoStatus,
  consolidatedContent,
  loadConsolidated,
  setConsolidatedContent,
  skills,
  toggleSkillBody,
  toggleSkillPin,
  openSkill,
  retired,
  showRetired,
  setShowRetired,
  loadEntries,
  loadingEntries,
  reviewEntries,
  reviewDecisions,
  setReviewEntries,
  setReviewDecisions,
  applyReview,
  teachInput,
  setTeachInput,
  runTeach,
  teachFeedback,
}: {
  selectedRole: string;
  selectedStats: CustomRosterStats;
  saving: boolean;
  setLearningEnabled: (role: string, enabled: boolean) => void;
  optimizing: boolean;
  runOptimize: (role: string) => void;
  autoStatus: AutoOptimizeStatus | null;
  consolidatedContent: string | null;
  loadConsolidated: (role: string) => void;
  setConsolidatedContent: (content: string | null) => void;
  skills: RoleSkill[] | null;
  toggleSkillBody: (role: string, skill: string) => void;
  toggleSkillPin: (role: string, skill: string, pinned: boolean) => void;
  openSkill: { skill: string; content: string } | null;
  retired: RetiredDirective[] | null;
  showRetired: boolean;
  setShowRetired: (updater: (open: boolean) => boolean) => void;
  loadEntries: (role: string) => void;
  loadingEntries: boolean;
  reviewEntries: string[] | null;
  reviewDecisions: Record<number, 'keep' | 'drop'>;
  setReviewEntries: (entries: string[] | null) => void;
  setReviewDecisions: React.Dispatch<React.SetStateAction<Record<number, 'keep' | 'drop'>>>;
  applyReview: () => void;
  teachInput: string;
  setTeachInput: (val: string) => void;
  runTeach: () => void;
  teachFeedback: { ok: boolean; msg: string } | null;
}) {
  const { t } = useAppTranslation();

  return (
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
      <div className="grid grid-cols-3 gap-2">
        <div className="rounded-lg border bg-card p-2">
          <span className="text-[9px] text-muted-foreground uppercase tracking-wider">
            {t('activity:agentRoster.entries')}
          </span>
          <div className="text-lg font-mono font-semibold mt-0.5">{selectedStats.entryCount}</div>
        </div>
        <div className="rounded-lg border bg-card p-2">
          <span className="text-[9px] text-muted-foreground uppercase tracking-wider">
            {t('activity:agentRoster.size')}
          </span>
          <div className="text-lg font-mono font-semibold mt-0.5">{selectedStats.totalBytes}B</div>
        </div>
        <div className="rounded-lg border bg-card p-2">
          <span className="text-[9px] text-muted-foreground uppercase tracking-wider">
            {t('activity:agentRoster.lifetimeCaptures')}
          </span>
          <div className="text-lg font-mono font-semibold mt-0.5">
            {selectedStats.lifetimeCaptureCount}
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
        <div
          className="rounded-lg border bg-card p-2"
          title="Share of directive applications that ended in a successful task. Blank until a directive has actually been exercised on one."
        >
          <span className="text-[9px] text-muted-foreground uppercase tracking-wider">
            {t('activity:agentRoster.hitRate')}
          </span>
          <div
            className={cn(
              'text-lg font-mono font-semibold mt-0.5',
              typeof selectedStats.directiveHitRate === 'number' &&
                (selectedStats.directiveHitRate >= 0.7
                  ? 'text-success'
                  : selectedStats.directiveHitRate < 0.4 && 'text-warning'),
            )}
          >
            {typeof selectedStats.directiveHitRate === 'number'
              ? `${Math.round(selectedStats.directiveHitRate * 100)}%`
              : '—'}
            {typeof selectedStats.appliedEntryCount === 'number' &&
              selectedStats.appliedEntryCount > 0 && (
                <span className="text-[9px] text-muted-foreground font-sans ml-1">
                  of {selectedStats.appliedEntryCount}
                </span>
              )}
          </div>
        </div>
        <div
          className="rounded-lg border bg-card p-2"
          title="Directives that have never been exercised on a task. Anchors — exact commands, paths, package names — are what let the runtime tell that a directive was applied."
        >
          <span className="text-[9px] text-muted-foreground uppercase tracking-wider">
            {t('activity:agentRoster.neverUsed')}
          </span>
          <div className="text-lg font-mono font-semibold mt-0.5">
            {typeof selectedStats.deadEntryCount === 'number' ? selectedStats.deadEntryCount : '—'}
          </div>
        </div>
      </div>

      {/* Proactive optimization warning */}
      {selectedStats.needsSummarization && (
        <div className="flex items-center gap-3 text-xs text-warning bg-warning/10 rounded-lg px-3 py-2.5">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span className="flex-1">
            {t('activity:agentRoster.learningsLimitExceeded', {
              bytes: selectedStats.totalBytes.toLocaleString(),
            })}
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
            <span className="text-xs font-semibold">
              {t('activity:agentRoster.optimizeLearnings')}
            </span>
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
          Synthesizes all {selectedStats.entryCount} raw entries into a single reviewed document —
          narrowly scoped to this agent's skills, preserving every fact but reducing context volume.
          The result replaces raw entries in the agent's prompt.
        </p>
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
            A developed skill carries a project addendum injected right after the bundled skill body
            — the agent reads one skill, refined for this codebase. Only the highest-ranked few are
            loaded per spawn; <span className="text-primary">loaded</span> marks those.
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
                  >
                    {entry.skill}
                  </button>
                  {entry.eager && (
                    <span
                      className="text-[9px] rounded bg-primary/15 text-primary px-1.5 py-0.5"
                      title="Ranked high enough to be loaded into a spawn of this role"
                    >
                      loaded
                    </span>
                  )}
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
                  {typeof entry.score === 'number' && (
                    <span
                      className="text-[9px] text-muted-foreground tabular-nums"
                      title="Project affinity score — higher is loaded first"
                    >
                      {entry.score.toFixed(2)}
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

      {/* Retired directives */}
      {retired && retired.length > 0 && (
        <div className="space-y-2 border border-border rounded-lg p-3 bg-card">
          <button
            type="button"
            onClick={() => setShowRetired((open) => !open)}
            className="flex w-full items-center gap-1.5 text-left"
          >
            <AlertTriangle className="h-4 w-4 text-warning" />
            <span className="text-xs font-semibold">Retired</span>
            <span className="text-[10px] text-muted-foreground">
              {retired.length} directive{retired.length === 1 ? '' : 's'} no longer injected
            </span>
            <span className="ml-auto text-[10px] text-muted-foreground">
              {showRetired ? 'hide' : 'show'}
            </span>
          </button>
          {showRetired && (
            <>
              <p className="text-[10px] text-muted-foreground leading-relaxed">
                Each of these was exercised repeatedly and kept correlating with failed tasks, so it
                was removed from the buffer and scrubbed out of the distilled documents.
              </p>
              <ul className="space-y-1">
                {retired.map((entry) => (
                  <li
                    key={entry.what}
                    className="rounded border border-border/60 px-2 py-1.5 text-[10px] leading-relaxed"
                  >
                    {entry.skill && (
                      <span className="mr-1.5 rounded bg-muted px-1 py-0.5 font-mono text-[9px] text-muted-foreground">
                        {entry.skill}
                      </span>
                    )}
                    <span className="text-muted-foreground line-through">{entry.what}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
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
            <span className={cn('text-xs', teachFeedback.ok ? 'text-success' : 'text-destructive')}>
              {teachFeedback.msg}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
