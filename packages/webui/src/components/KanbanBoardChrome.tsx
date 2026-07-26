import type {
  KanbanBoard,
  KanbanBoardPresence,
  KanbanModelRoutingMode,
  KanbanSupervisorSnapshot,
} from '@wrongstack/kanban';
import { Activity, ChevronDown, CircleUserRound, Clock3, Save, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useKanbanMeta } from '@/hooks/useKanbanMeta';
import { useProviderModels } from '@/hooks/useProviderModels';
import { cn } from '@/lib/utils';
import { ChipMultiSelect } from './ChipMultiSelect';
import { ModelPicker } from './ModelPicker';

function relativeLastSeen(lastSeenAt: string): string {
  const elapsed = Math.max(0, Date.now() - Date.parse(lastSeenAt));
  if (elapsed < 60_000) return 'just now';
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  return `${Math.floor(elapsed / 3_600_000)}h ago`;
}

function fmtElapsed(fromIso?: string, toIso?: string): string | null {
  if (!fromIso) return null;
  const from = Date.parse(fromIso);
  const to = toIso ? Date.parse(toIso) : Date.now();
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  const seconds = Math.max(0, Math.floor((to - from) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function BoardPresence({ presence = [] }: { presence?: KanbanBoardPresence[] | undefined }) {
  if (presence.length === 0) return null;
  return (
    <section
      aria-label="Board presence"
      className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-card/50 px-4 py-2"
    >
      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        Live board users
      </span>
      {presence.map((entry) => (
        <span
          key={entry.id}
          className="inline-flex min-w-0 items-center gap-1.5 rounded-full border border-border bg-background px-2.5 py-1 text-xs shadow-sm"
          title={`Session ${entry.sessionId} · last seen ${entry.lastSeenAt}`}
        >
          <span
            role="img"
            aria-label={entry.active ? 'active' : 'inactive'}
            className={cn(
              'h-2 w-2 shrink-0 rounded-full',
              entry.active ? 'bg-success' : 'bg-muted-foreground/50',
            )}
          />
          <CircleUserRound size={13} aria-hidden="true" />
          <span className="max-w-32 truncate font-medium">{entry.agentName ?? entry.agentId}</span>
          <span className="max-w-32 truncate text-muted-foreground">{entry.sessionId}</span>
          <Clock3 size={12} className="text-muted-foreground" aria-hidden="true" />
          <time dateTime={entry.lastSeenAt} className="tabular-nums text-muted-foreground">
            {relativeLastSeen(entry.lastSeenAt)}
          </time>
        </span>
      ))}
    </section>
  );
}

export function SupervisorBar({
  board,
  snapshot,
  sendKanban,
}: {
  board: KanbanBoard;
  snapshot: KanbanSupervisorSnapshot | null;
  sendKanban: (type: `kanban.${string}`, payload?: Record<string, unknown>) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [mode, setMode] = useState<'deterministic' | 'agentic'>('deterministic');
  const [routingMode, setRoutingMode] = useState<KanbanModelRoutingMode>('session');
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [fallbackProfile, setFallbackProfile] = useState('');
  const [fallbackModels, setFallbackModels] = useState<string[]>([]);
  const [skills, setSkills] = useState<string[]>([]);
  const [intervalSeconds, setIntervalSeconds] = useState(10);
  const modelCandidates = useProviderModels(expanded && mode === 'agentic');
  const meta = useKanbanMeta(expanded && mode === 'agentic');

  useEffect(() => {
    const config = board.supervisor;
    setEnabled(config?.enabled ?? true);
    setMode(config?.mode ?? 'deterministic');
    setRoutingMode(config?.routing?.mode ?? 'session');
    setProvider(config?.routing?.provider ?? '');
    setModel(config?.routing?.model ?? '');
    setFallbackProfile(config?.routing?.fallbackProfile ?? '');
    setFallbackModels(config?.routing?.fallbackModels ?? []);
    setSkills(config?.skills ?? []);
    setIntervalSeconds(Math.max(2, Math.round((config?.intervalMs ?? 10_000) / 1000)));
  }, [board.id, board.supervisor]);

  const save = () => {
    const routing = {
      mode: routingMode,
      ...(routingMode === 'fixed' && provider ? { provider } : {}),
      ...(routingMode === 'fixed' && model ? { model } : {}),
      ...(routingMode === 'fallback_profile' && fallbackProfile ? { fallbackProfile } : {}),
      ...(fallbackModels.length ? { fallbackModels } : {}),
    };
    sendKanban('kanban.update', {
      boardId: board.id,
      supervisor: {
        enabled,
        mode,
        intervalMs: Math.max(2, intervalSeconds) * 1000,
        recoveryMode: 'auto',
        ...(mode === 'agentic' ? { routing, skills } : {}),
      },
    });
    window.setTimeout(() => sendKanban('kanban.supervisor.audit', { boardId: board.id }), 150);
  };

  const status = enabled ? (snapshot?.status ?? 'starting') : 'disabled';
  return (
    <div className="shrink-0 border-b bg-background/80">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center gap-2 px-4 py-1.5 text-left text-[11px] hover:bg-muted/40"
      >
        <ShieldCheck size={13} className={status === 'healthy' ? 'text-success' : 'text-warning'} />
        <span className="font-semibold">Kanban Agent</span>
        <span className="rounded bg-muted px-1.5 py-0.5 capitalize text-muted-foreground">
          {mode} · {status}
        </span>
        {snapshot?.summary && (
          <span className="min-w-0 flex-1 truncate text-muted-foreground">{snapshot.summary}</span>
        )}
        <span className="ml-auto text-muted-foreground">
          {snapshot?.lastAuditAt
            ? `checked ${fmtElapsed(snapshot.lastAuditAt)} ago`
            : 'not checked'}
        </span>
        <ChevronDown size={13} className={cn('transition-transform', expanded && 'rotate-180')} />
      </button>
      {expanded && (
        <div className="grid gap-3 border-t p-3 text-xs lg:grid-cols-[220px_220px_1fr_auto]">
          <label className="flex items-center gap-2 rounded-md border bg-card px-2 py-2">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
            />
            <span>Watch this board</span>
          </label>
          <SelectField
            label="Supervisor engine"
            value={mode}
            options={['deterministic', 'agentic']}
            onChange={(value) => setMode(value as 'deterministic' | 'agentic')}
          />
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium text-muted-foreground">
              Audit interval (seconds)
            </span>
            <input
              type="number"
              min={2}
              value={intervalSeconds}
              onChange={(event) => setIntervalSeconds(Number(event.target.value) || 2)}
              className="h-8 w-full rounded-md border bg-background px-2 outline-none focus:border-primary"
            />
          </label>
          <div className="flex items-end gap-2">
            <button
              type="button"
              onClick={save}
              className="inline-flex h-8 items-center gap-1 rounded-md bg-primary px-3 text-primary-foreground"
            >
              <Save size={13} /> Save
            </button>
            <button
              type="button"
              onClick={() => sendKanban('kanban.supervisor.audit', { boardId: board.id })}
              className="inline-flex h-8 items-center gap-1 rounded-md border px-3 hover:bg-muted"
            >
              <Activity size={13} /> Audit now
            </button>
          </div>
          {mode === 'deterministic' ? (
            <div className="lg:col-span-4 rounded-md border border-success/20 bg-success/5 px-3 py-2 text-muted-foreground">
              Deterministic mode uses no provider, model, token, or billing. It repairs
              assignment/status/column drift and recovers expired leases.
            </div>
          ) : (
            <div className="grid gap-3 lg:col-span-4 lg:grid-cols-2">
              <SelectField
                label="Kanban Agent model source"
                value={routingMode}
                options={['session', 'fixed', 'fallback_profile']}
                onChange={(value) => setRoutingMode(value as KanbanModelRoutingMode)}
              />
              {routingMode === 'fixed' && (
                <div>
                  <span className="mb-1 block text-[11px] font-medium text-muted-foreground">
                    Fixed provider / model
                  </span>
                  <ModelPicker
                    value={model || undefined}
                    provider={provider || undefined}
                    candidates={modelCandidates}
                    placeholder="Select exact provider / model…"
                    onPick={(nextModel, nextProvider) => {
                      setModel(nextModel);
                      setProvider(nextProvider);
                    }}
                  />
                </div>
              )}
              {routingMode === 'fallback_profile' && (
                <SelectField
                  label="Fallback profile (first model is primary)"
                  value={fallbackProfile}
                  options={Object.keys(meta.fallbackProfiles)}
                  placeholder="Select configured profile…"
                  onChange={setFallbackProfile}
                />
              )}
              <div>
                <span className="mb-1 block text-[11px] font-medium text-muted-foreground">
                  Supervisor skills
                </span>
                <ChipMultiSelect
                  options={meta.skills.map((skill) => ({
                    value: skill.name,
                    label: skill.name,
                    description: skill.description,
                    tag: skill.source,
                  }))}
                  selected={skills}
                  onChange={setSkills}
                  placeholder="Force-load agentic skills…"
                />
              </div>
              <div>
                <span className="mb-1 block text-[11px] font-medium text-muted-foreground">
                  Extra fallback models
                </span>
                <ChipMultiSelect
                  options={modelCandidates.map((candidate) => ({
                    value: `${candidate.provider}/${candidate.model}`,
                    label: candidate.label,
                    tag: candidate.provider,
                  }))}
                  selected={fallbackModels}
                  onChange={setFallbackModels}
                  placeholder="Optional ordered fallbacks…"
                />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SelectField({
  label,
  value,
  options,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
  placeholder?: string | undefined;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium text-muted-foreground">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-8 w-full rounded-md border bg-background px-2 text-xs outline-none focus:border-primary"
      >
        {placeholder && <option value="">{placeholder}</option>}
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}
