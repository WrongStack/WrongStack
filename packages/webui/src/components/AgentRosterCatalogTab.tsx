import { Activity, Bot, ChevronDown, Database, FileText, Search, Settings, X } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import type { CustomRosterStats, RosterAgentEntry } from './agent-roster-data.js';

export function RosterCatalogTab({
  customStats,
  catalog,
}: {
  customStats: CustomRosterStats[];
  catalog: RosterAgentEntry[];
}) {
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedRole, setExpandedRole] = useState<string | null>(null);
  const customRoles = useMemo(
    () =>
      new Set(
        customStats
          .filter((s) => s.exists || s.hasIdentity || s.hasConfig || s.hasKnowledge)
          .map((s) => s.role),
      ),
    [customStats],
  );

  const filtered = useMemo(() => {
    if (!searchQuery.trim()) return catalog;
    const q = searchQuery.toLowerCase();
    return catalog.filter(
      (r) =>
        r.role.includes(q) ||
        r.name.toLowerCase().includes(q) ||
        r.summary.toLowerCase().includes(q),
    );
  }, [catalog, searchQuery]);

  const customRoleStats = useCallback(
    (role: string) => customStats.find((s) => s.role === role),
    [customStats],
  );

  const roleList = filtered;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {/* Search bar */}
      <div className="shrink-0 px-3 py-2 border-b border-border/50">
        <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-background px-3 py-1.5">
          <Search className="h-3.5 w-3.5 text-muted-foreground" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search agents by name, role, or description…"
            className="flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/50"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>

      {/* Grid */}
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
          {roleList.map((role) => {
            const stats = customRoleStats(role.role);
            const isCustom = customRoles.has(role.role);
            const isExpanded = expandedRole === role.role;

            return (
              <div
                key={role.role}
                className={cn(
                  'rounded-lg border bg-card transition-colors',
                  isExpanded
                    ? 'border-primary/40 ring-1 ring-primary/20'
                    : 'border-border/60 hover:border-primary/30',
                )}
              >
                <button
                  type="button"
                  onClick={() => setExpandedRole(isExpanded ? null : role.role)}
                  className="w-full text-left p-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <Bot className="h-4 w-4 shrink-0 text-primary" />
                      <span className="text-sm font-semibold truncate">{role.name}</span>
                      <code className="text-[9px] text-muted-foreground font-mono shrink-0">
                        @{role.role}
                      </code>
                    </div>
                    <ChevronDown
                      className={cn(
                        'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform',
                        isExpanded && 'rotate-180',
                      )}
                    />
                  </div>
                  <p className="text-[10px] text-muted-foreground mt-1 leading-relaxed line-clamp-2">
                    {role.summary}
                  </p>
                  <div className="flex items-center gap-2 mt-1.5">
                    <span className="text-[9px] text-muted-foreground tabular-nums">
                      {role.tools} tools
                    </span>
                    {role.budget.maxIterations && (
                      <span className="text-[9px] text-muted-foreground tabular-nums">
                        {role.budget.maxIterations.toLocaleString()} max it
                      </span>
                    )}
                    {isCustom && (
                      <span className="inline-flex items-center gap-0.5 rounded bg-brand-2/10 px-1 py-0.5 text-[8px] text-brand-2 font-medium">
                        <FileText className="h-2.5 w-2.5" /> Customized
                      </span>
                    )}
                    {stats?.needsSummarization && (
                      <span className="text-[9px] text-warning">⚠ Needs summary</span>
                    )}
                  </div>
                </button>

                {/* Expanded details */}
                {isExpanded && (
                  <div className="border-t border-border/50 px-3 py-2 space-y-2">
                    <div className="grid grid-cols-2 gap-2">
                      <div className="rounded bg-muted/30 p-1.5">
                        <span className="text-[8px] text-muted-foreground uppercase tracking-wider">
                          Max Iterations
                        </span>
                        <div className="text-xs font-mono mt-0.5">
                          {role.budget.maxIterations?.toLocaleString() ?? '—'}
                        </div>
                      </div>
                      <div className="rounded bg-muted/30 p-1.5">
                        <span className="text-[8px] text-muted-foreground uppercase tracking-wider">
                          Timeout
                        </span>
                        <div className="text-xs font-mono mt-0.5">
                          {role.budget.timeoutMs
                            ? `${Math.round(role.budget.timeoutMs / 60000)}m`
                            : '—'}
                        </div>
                      </div>
                      <div className="rounded bg-muted/30 p-1.5">
                        <span className="text-[8px] text-muted-foreground uppercase tracking-wider">
                          Max Tool Calls
                        </span>
                        <div className="text-xs font-mono mt-0.5">
                          {role.budget.maxToolCalls?.toLocaleString() ?? '—'}
                        </div>
                      </div>
                      <div className="rounded bg-muted/30 p-1.5">
                        <span className="text-[8px] text-muted-foreground uppercase tracking-wider">
                          Customized
                        </span>
                        <div className="text-xs font-mono mt-0.5">{isCustom ? 'Yes' : 'No'}</div>
                      </div>
                    </div>

                    {isCustom && stats && (
                      <div className="rounded bg-accent/30 p-2 space-y-1">
                        <span className="text-[9px] font-medium text-muted-foreground">
                          Project Customizations
                        </span>
                        <div className="flex flex-wrap gap-2 text-[9px]">
                          {stats.hasIdentity && (
                            <span className="inline-flex items-center gap-0.5">
                              <FileText className="h-2.5 w-2.5 text-primary" /> identity.md
                            </span>
                          )}
                          {stats.entryCount > 0 && (
                            <span className="inline-flex items-center gap-0.5">
                              <Database className="h-2.5 w-2.5 text-brand-2" /> {stats.entryCount}{' '}
                              learned entries
                            </span>
                          )}
                          {stats.hasConfig && (
                            <span className="inline-flex items-center gap-0.5">
                              <Settings className="h-2.5 w-2.5 text-muted-foreground" /> config.json
                            </span>
                          )}
                          {stats.sessionCaptureCount > 0 && (
                            <span className="inline-flex items-center gap-0.5">
                              <Activity className="h-2.5 w-2.5 text-success" />{' '}
                              {stats.sessionCaptureCount} session captures
                            </span>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {roleList.length === 0 && (
          <div className="flex flex-col items-center justify-center h-40 text-muted-foreground">
            <Search className="h-8 w-8 mb-2 opacity-30" />
            <p className="text-sm">No agents match "{searchQuery}"</p>
          </div>
        )}
      </div>

      {/* Footer stats */}
      <div className="shrink-0 border-t border-border/50 px-3 py-2 text-[10px] text-muted-foreground flex items-center gap-2">
        <span>
          <strong>{catalog.length}</strong> roster roles
        </span>
        <span className="text-muted-foreground/50">·</span>
        <span className="text-brand-2">
          <strong>{customRoles.size}</strong> customized
        </span>
        <span className="text-muted-foreground/50">·</span>
        <span>
          <strong>{customStats.reduce((sum, s) => sum + s.entryCount, 0)}</strong> total learned
          entries
        </span>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════
//  TAB: Self-Learning
// ══════════════════════════════════════════════════════════════════════
