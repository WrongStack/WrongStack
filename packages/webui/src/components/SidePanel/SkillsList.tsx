/**
 * SkillsList — the skill list shown in the SidePanel when Skills activity is active.
 * When a skill is clicked, it opens in the main content area (SkillDetailView).
 */
import { Download, FileText, Loader2, Plus, RefreshCw, Sparkles } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useWebSocket } from '@/hooks/useWebSocket';
import { useAppTranslation } from '@/i18n';
import { looseTranslate } from '@/i18n/loose-translate';
import { cn } from '@/lib/utils';
import { showPanel } from '@/lib/view-navigation';
import { useUIStore } from '@/stores/ui-store';
import { SkillCreateDialog, useSkillCreateForm } from './SkillCreateDialog.js';
import { SkillInstallDialog, useSkillInstallForm } from './SkillInstallDialog.js';
import {
  bucketForSource,
  ScopeBadge,
  type ScopeBucket,
  type ScopeFilter,
  type SkillInfo,
  scopeLabelFor,
} from './SkillsListScope.js';
import { useSkillsOneShotListener } from './use-skills-one-shot.js';

export function SkillsList({ className }: { className?: string }) {
  const { t } = useAppTranslation();
  const { client } = useWebSocket();
  const skillsState = useUIStore((s) => s.skillsState);
  const setSkillsState = useUIStore((s) => s.setSkillsState);

  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');

  // Always-accessible ref to current skillsState
  const skillsStateRef = useRef(skillsState);
  skillsStateRef.current = skillsState;
  // One-shot WS listeners (install/create/export) — see use-skills-one-shot.ts.
  const listenOnce = useSkillsOneShotListener(client);

  // Install / create modal state + requests.
  const installForm = useSkillInstallForm(client, listenOnce);
  const createForm = useSkillCreateForm(client, listenOnce);
  const { installModalOpen, setInstallModalOpen } = installForm;
  const { createModalOpen, setCreateModalOpen } = createForm;

  // Export all state
  const [exportingAll, setExportingAll] = useState(false);

  // Check for updates state
  const [checkingForUpdates, setCheckingForUpdates] = useState(false);
  // Fail-safe timer for the refresh round-trip (cleared on reply/unmount).
  const refreshTimeoutRef = useRef<number | null>(null);

  // Hand-rolled overlays (not Radix Dialog): close the open one on Escape.
  useEffect(() => {
    if (!installModalOpen && !createModalOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (installModalOpen) setInstallModalOpen(false);
      if (createModalOpen) setCreateModalOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [installModalOpen, createModalOpen]);

  // Handle refresh all
  const handleRefreshAll = useCallback(() => {
    if (!client) return;
    setCheckingForUpdates(true);
    // Fail-safe: a lost `skills.updated` frame (server restart, socket drop)
    // must not leave the refresh spinner stuck — the same protection
    // handleExportAll gets from listenOnce's timeout.
    if (refreshTimeoutRef.current !== null) window.clearTimeout(refreshTimeoutRef.current);
    refreshTimeoutRef.current = window.setTimeout(() => {
      refreshTimeoutRef.current = null;
      setCheckingForUpdates(false);
    }, 30_000);
    client.checkForUpdates(undefined, undefined);
  }, [client]);

  // Handle export all
  const handleExportAll = useCallback(() => {
    if (!client) return;
    setExportingAll(true);
    listenOnce(
      'skills.exported',
      (msg) => {
        const m = msg as { payload: { zipBase64: string; skillCount: number; error?: string } };
        setExportingAll(false);
        if (m.payload.error) {
          console.error(m.payload.error);
          return;
        }
        const binary = atob(m.payload.zipBase64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
        const blob = new Blob([bytes], { type: 'application/zip' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `wrongstack-skills-${Date.now()}.zip`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      },
      () => setExportingAll(false),
      // Large skill sets can take a while to zip server-side.
      30_000,
    );
    client.exportAllSkills();
  }, [client, listenOnce]);

  // Load skills on mount
  useEffect(() => {
    if (!client) return;
    setLoading(true);

    const handleSkillsList = (msg: unknown) => {
      const m = msg as { payload: { enabled: boolean; skills: SkillInfo[]; error?: string } };
      if (m.payload.enabled && m.payload.skills) {
        setSkills(m.payload.skills);

        // Compute updateAvailableCount
        const currentState = skillsStateRef.current;
        const knownRefs = currentState.knownRefs;
        let updateCount = 0;
        const newKnownRefs = { ...knownRefs };
        for (const skill of m.payload.skills) {
          if (skill.source === 'bundled') continue;
          const currentRef = skill.ref;
          if (!currentRef) continue;
          const knownRef = knownRefs[skill.name];
          newKnownRefs[skill.name] = currentRef;
          if (knownRef && knownRef !== currentRef) {
            updateCount++;
          }
        }
        setSkillsState({
          ...currentState,
          knownRefs: newKnownRefs,
          updateAvailableCount: updateCount,
        });
      }
      setLoading(false);
    };

    const handleSkillsUpdated = (msg: unknown) => {
      const m = msg as {
        payload: {
          success: boolean;
          error: string | null;
          updated?: Array<{ name: string; oldRef: string; newRef: string }>;
          unchanged?: string[];
          errors?: Array<{ name: string; error: string }>;
        };
      };
      if (refreshTimeoutRef.current !== null) {
        window.clearTimeout(refreshTimeoutRef.current);
        refreshTimeoutRef.current = null;
      }
      setCheckingForUpdates(false);
      if (m.payload.success) {
        const currentState = skillsStateRef.current;
        const newKnownRefs = { ...currentState.knownRefs };
        for (const u of m.payload.updated ?? []) {
          newKnownRefs[u.name] = u.newRef;
        }
        setSkillsState({
          ...currentState,
          knownRefs: newKnownRefs,
          updateAvailableCount: 0,
        });
        client.send({ type: 'skills.list' }, { echoToChat: false });
      }
    };

    client.on('skills.list', handleSkillsList as (msg: unknown) => void);
    client.on('skills.updated', handleSkillsUpdated as (msg: unknown) => void);
    client.send({ type: 'skills.list' }, { echoToChat: false });

    return () => {
      client.off('skills.list', handleSkillsList as (msg: unknown) => void);
      client.off('skills.updated', handleSkillsUpdated as (msg: unknown) => void);
      if (refreshTimeoutRef.current !== null) {
        window.clearTimeout(refreshTimeoutRef.current);
        refreshTimeoutRef.current = null;
      }
    };
  }, [client, setSkillsState]);

  // Handle skill click — open in main content area
  const handleSelectSkill = useCallback(
    (skill: SkillInfo) => {
      setSkillsState({
        ...skillsStateRef.current,
        selectedSkill: skill,
        navHistory: [skill],
        historyIndex: 0,
        detailOpen: true,
      });
      showPanel('skills');
    },
    [setSkillsState],
  );

  const filteredSkills = useMemo(() => {
    let result = skills;

    if (scopeFilter !== 'all') {
      result = result.filter((s) => bucketForSource(s.source) === scopeFilter);
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          s.description.toLowerCase().includes(q) ||
          s.trigger.toLowerCase().includes(q),
      );
    }

    return result;
  }, [skills, scopeFilter, searchQuery]);

  const groupedSkills = useMemo(() => {
    // Keyed by ScopeBucket, not `string`: `bucketForSource` is total over the
    // four buckets, and saying so keeps the push below from reading as an
    // unchecked index into a possibly-absent array.
    const groups: Record<ScopeBucket, SkillInfo[]> = {
      project: [],
      user: [],
      foreign: [],
      bundled: [],
    };
    for (const skill of filteredSkills) {
      groups[bucketForSource(skill.source)].push(skill);
    }
    return groups;
  }, [filteredSkills]);

  const selectedSkillName = skillsState.selectedSkill?.name;

  return (
    <div
      className={cn(
        'flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-[hsl(var(--surface-2)/0.28)]',
        className,
      )}
    >
      {/* Icon rail */}
      <div className="flex w-full items-center gap-1 border-b border-border/60 bg-card/65 px-2 py-2">
        <button
          type="button"
          onClick={installForm.openInstallModal}
          className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title={t('activity:skillsList.installTitle')}
        >
          <Plus className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={createForm.openCreateModal}
          className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title={t('activity:skillsList.createTitle')}
        >
          <FileText className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={handleExportAll}
          disabled={exportingAll || skills.length === 0}
          className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
          title={t('activity:skillsList.exportTitle')}
        >
          {exportingAll ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Download className="h-4 w-4" />
          )}
        </button>
        <button
          type="button"
          onClick={handleRefreshAll}
          disabled={checkingForUpdates}
          className="relative flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
          title={t('activity:skillsList.checkUpdatesTitle')}
        >
          {checkingForUpdates ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
          {!checkingForUpdates && skillsState.updateAvailableCount > 0 && (
            <span className="absolute top-0.5 right-0.5 h-2.5 w-2.5 rounded-full bg-primary text-[8px] font-bold text-primary-foreground flex items-center justify-center">
              {skillsState.updateAvailableCount > 9 ? '9+' : skillsState.updateAvailableCount}
            </span>
          )}
        </button>
      </div>
      {/* Search + filter */}
      <div className="shrink-0 space-y-2 border-b border-border/60 bg-card/45 p-2">
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder={t('activity:skillsList.searchPlaceholder')}
          aria-label={t('activity:skillsList.searchPlaceholder')}
          className="w-full rounded-md border border-border/70 bg-background/70 px-2 py-1.5 text-xs shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
        />
        <div className="flex gap-1 flex-wrap">
          {(['all', 'project', 'user', 'foreign', 'bundled'] as ScopeFilter[]).map((scope) => {
            const count =
              scope === 'all'
                ? filteredSkills.length
                : filteredSkills.filter((s) => bucketForSource(s.source) === scope).length;
            return (
              <button
                key={scope}
                type="button"
                onClick={() => setScopeFilter(scope)}
                className={cn(
                  'rounded-md px-1.5 py-0.5 text-[10px] transition-colors',
                  scopeFilter === scope
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-background/60 text-muted-foreground hover:bg-accent',
                )}
              >
                {scope === 'all' ? t('common:action.all') : scopeLabelFor(looseTranslate(t), scope)}
                <span
                  className={cn(
                    'ml-1 font-medium',
                    scopeFilter === scope ? 'opacity-90' : 'opacity-60',
                    count === 0 && 'line-through',
                  )}
                >
                  ({count})
                </span>
              </button>
            );
          })}
        </div>
      </div>
      {/* Skill list */}
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain p-2 [scrollbar-gutter:stable]">
        {loading ? (
          <div className="rounded-lg border border-border/60 bg-card/55 p-4 text-center text-xs text-muted-foreground">
            {t('activity:skillsList.loading')}
          </div>
        ) : filteredSkills.length === 0 ? (
          <div className="rounded-lg border border-border/60 bg-card/55 p-4 text-center text-xs text-muted-foreground">
            {skills.length === 0
              ? t('activity:skillsList.noSkills')
              : t('activity:skillsList.noMatch')}
          </div>
        ) : (
          <div className="space-y-2">
            {(['project', 'user', 'foreign', 'bundled'] as const).map((scope) => {
              const group = groupedSkills[scope];
              if (group.length === 0) return null;
              return (
                <div key={scope}>
                  <div className="flex items-center gap-1 px-1 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    <ScopeBadge source={scope} />
                    <span className="ml-auto opacity-60">{group.length}</span>
                  </div>
                  {group.map((skill) => (
                    <button
                      key={skill.name}
                      type="button"
                      onClick={() => handleSelectSkill(skill)}
                      className={cn(
                        'ws-picker-option w-full rounded-xl border px-3 py-3 text-left text-xs transition-colors',
                        selectedSkillName === skill.name
                          ? 'border-primary/30 bg-primary/10 text-primary shadow-sm'
                          : 'border-border/50 bg-card/55 text-foreground hover:border-border hover:bg-accent/50',
                      )}
                    >
                      <div className="font-medium truncate flex items-center gap-1">
                        <Sparkles className="h-3 w-3 shrink-0" />
                        {skill.name}
                      </div>
                      <div className="text-[10px] text-muted-foreground truncate mt-0.5">
                        {skill.trigger ||
                          skill.description?.slice(0, 50) ||
                          t('activity:skillsList.noDescription')}
                      </div>
                    </button>
                  ))}
                </div>
              );
            })}
          </div>
        )}
      </div>{' '}
      <SkillInstallDialog form={installForm} />
      <SkillCreateDialog form={createForm} />
    </div>
  );
}
