/**
 * Control — staged remote command dispatch.
 *
 * The flow is deliberately slow: pick a target → pick a type → compose →
 * PREVIEW the exact payload → dispatch, with destructive types additionally
 * demanding a typed confirmation word. A remote abort or shell command is not
 * something to fire from a single click.
 *
 * Only clients advertising `control.receive` are targetable. `run-command`
 * additionally requires the client to have been started with
 * `--hq-allow-exec` and the operator's token to carry `control.execute` — the
 * server enforces both; this view only explains them.
 */
import type { HqCommandAuditEntry } from '@wrongstack/core/hq';
import {
  Bot,
  ListPlus,
  Megaphone,
  MessageSquareText,
  OctagonX,
  SquareTerminal,
  TriangleAlert,
  Zap,
} from 'lucide-react';
import type * as React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { EmptyState, Mono } from '../../components/hq/primitives.js';
import { HeroMetric, ViewHero, ViewShell } from '../../components/hq/view-chrome.js';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card.js';
import { Input, Select, Textarea } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { fetchJson, postCommand } from '../../data/api.js';
import { setHqControlPrefs, useHqLocalPrefs } from '../../data/local-prefs.js';
import { useHqStore } from '../../data/store/index.js';
import { controlClientLabel, shortId } from '../../domain/control-format.js';
import {
  buildControlDraft,
  confirmWordFor,
  type ControlCommandType,
} from '../../domain/control-draft.js';
import { cn } from '../../lib/utils.js';
import { CommandAuditRail } from './audit-rail.js';

const AUDIT_LIMIT = 25;
const AUDIT_POLL_MS = 15_000;

type Stage = 'compose' | 'preview';

interface CommandsResponse {
  commands: HqCommandAuditEntry[];
}

/** What each command type does — rendered on the type cards so the plane
 *  explains itself instead of presenting seven bare words. */
const COMMAND_META: Record<
  ControlCommandType,
  { label: string; icon: React.ElementType; description: string; danger?: boolean }
> = {
  steer: {
    label: 'steer',
    icon: Zap,
    description: 'High-priority course correction — interrupts the agent at the next safe turn.',
  },
  btw: {
    label: 'btw',
    icon: MessageSquareText,
    description: 'Non-urgent FYI — rides alongside the run without interrupting it.',
  },
  queue: {
    label: 'queue',
    icon: ListPlus,
    description: 'Queue a prompt — picked up after the current run finishes.',
  },
  abort: {
    label: 'abort',
    icon: OctagonX,
    description: 'Stop the leader run, or every subagent on the client. Destructive.',
    danger: true,
  },
  spawn: {
    label: 'spawn',
    icon: Bot,
    description: 'Launch a role subagent (bug-hunter, critic, …) with an optional task.',
  },
  broadcast: {
    label: 'broadcast',
    icon: Megaphone,
    description: 'Mailbox message to every agent in the client’s project.',
  },
  'run-command': {
    label: 'run-command',
    icon: SquareTerminal,
    description:
      'Route a shell command to the client. Gated on --hq-allow-exec plus control.execute.',
    danger: true,
  },
};

const COMMAND_TYPES = Object.keys(COMMAND_META) as ControlCommandType[];

const SPAWN_ROLES = [
  'bug-hunter',
  'refactor-planner',
  'critic',
  'security-scanner',
  'code-reviewer',
];

function DangerNote({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <p className="flex items-start gap-1.5 border border-destructive/40 bg-destructive/5 px-2 py-1.5 text-[11px] text-destructive">
      <TriangleAlert className="mt-px size-3 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

export function ControlView(): React.ReactElement {
  const { snapshot, selectedClientId, commandStatuses } = useHqStore(
    useShallow((state) => ({
      snapshot: state.snapshot,
      selectedClientId: state.selectedClientId,
      commandStatuses: state.commandStatuses,
    })),
  );

  const clients = (snapshot?.clients ?? []).filter((client) =>
    client.capabilities.includes('control.receive'),
  );
  const targetId = clients.some((client) => client.clientId === selectedClientId)
    ? selectedClientId
    : (clients[0]?.clientId ?? null);
  const targetClient = clients.find((client) => client.clientId === targetId) ?? null;
  const targetSession =
    targetClient === null
      ? undefined
      : (snapshot?.liveSessions ?? []).find(
          (session) =>
            session.clientId === targetClient.clientId ||
            (session.machineId === targetClient.machineId &&
              session.projectId === targetClient.projectId &&
              session.pid !== undefined &&
              session.pid === targetClient.pid),
        );

  const prefs = useHqLocalPrefs().control;

  const [type, setType] = useState<ControlCommandType>(prefs.cmdType);
  const [stage, setStage] = useState<Stage>('compose');
  const [steerTo, setSteerTo] = useState(prefs.steerTo);
  const [steerSubject, setSteerSubject] = useState(prefs.steerSubject);
  const [steerBody, setSteerBody] = useState(prefs.steerBody);
  const [spawnRole, setSpawnRole] = useState(prefs.spawnRole);
  const [spawnTask, setSpawnTask] = useState(prefs.spawnTask);
  const [abortTarget, setAbortTarget] = useState(prefs.abortTarget);
  const [broadcastSubject, setBroadcastSubject] = useState(prefs.broadcastSubject);
  const [broadcastBody, setBroadcastBody] = useState(prefs.broadcastBody);
  // Deliberately NOT persisted: a shell command left in storage is a loaded
  // gun the next time this tab opens.
  const [runCommand, setRunCommand] = useState('');
  const [runCwd, setRunCwd] = useState('');
  const [confirmText, setConfirmText] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [auditEntries, setAuditEntries] = useState<HqCommandAuditEntry[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [lastDispatchedId, setLastDispatchedId] = useState<string | null>(null);

  const draft = useMemo(
    () =>
      buildControlDraft({
        type,
        steerTo,
        steerSubject,
        steerBody,
        spawnRole,
        spawnTask,
        abortTarget,
        broadcastSubject,
        broadcastBody,
        runCommand,
        runCwd,
      }),
    [
      type,
      steerTo,
      steerSubject,
      steerBody,
      spawnRole,
      spawnTask,
      abortTarget,
      broadcastSubject,
      broadcastBody,
      runCommand,
      runCwd,
    ],
  );

  const confirmWord = confirmWordFor(type);
  const canPreview = draft.disabledReason === null && targetId !== null;
  const canDispatch =
    canPreview && (confirmWord === null || confirmText === confirmWord);

  const resetToCompose = useCallback((): void => {
    setStage('compose');
    setConfirmText('');
    setError(null);
    setStatus(null);
  }, []);

  const chooseType = (next: ControlCommandType): void => {
    setType(next);
    setHqControlPrefs({ cmdType: next });
    resetToCompose();
  };

  const loadAudit = useCallback(async (): Promise<void> => {
    setAuditLoading(true);
    setAuditError(null);
    try {
      const data = await fetchJson<CommandsResponse>(`/api/commands?limit=${AUDIT_LIMIT}`);
      setAuditEntries([...data.commands].reverse());
    } catch (cause) {
      setAuditError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setAuditLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAudit();
    // Skip refreshes while the tab is hidden — the audit only matters to
    // someone looking at it, and this view is often left open for hours.
    const timer = window.setInterval(() => {
      if (!document.hidden) void loadAudit();
    }, AUDIT_POLL_MS);
    return () => window.clearInterval(timer);
  }, [loadAudit]);

  // Live lifecycle updates arrive over the socket; merge them into the polled
  // list so a row moves queued → delivered → acked without waiting for a poll.
  useEffect(() => {
    if (commandStatuses.length === 0) return;
    setAuditEntries((current) => {
      const merged = new Map(current.map((entry) => [entry.commandId, entry]));
      for (const command of commandStatuses) merged.set(command.commandId, command);
      return [...merged.values()]
        .sort((left, right) => right.enqueuedAt.localeCompare(left.enqueuedAt))
        .slice(0, AUDIT_LIMIT);
    });
  }, [commandStatuses]);

  const dispatch = useCallback(async (): Promise<void> => {
    if (targetId === null || !canDispatch) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const result = await postCommand(targetId, draft.type, draft.payload);
      setStatus(`queued ${draft.type} command ${result.commandId}`);
      setLastDispatchedId(result.commandId);
      setStage('compose');
      setConfirmText('');
      void loadAudit();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [canDispatch, draft, loadAudit, targetId]);

  // Ctrl+Enter advances one step of the staged flow: compose → preview →
  // dispatch. It never skips the preview.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      if (stage === 'compose' && canPreview) {
        setStage('preview');
        setStatus(null);
        setError(null);
        return;
      }
      if (stage === 'preview' && canDispatch && !busy) void dispatch();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [busy, canDispatch, canPreview, dispatch, stage]);

  if (clients.length === 0) {
    return (
      <ViewShell>
        <EmptyState
          icon={SquareTerminal}
          title="No command-ready clients"
          hint="Connect a CLI, TUI or WebUI client advertising control.receive to unlock staged remote commands and their audit trail."
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => useHqStore.getState().setActiveView('fleet')}
            >
              Inspect Fleet Map
            </Button>
          }
        />
      </ViewShell>
    );
  }

  const meta = COMMAND_META[type];

  return (
    <ViewShell>
      <div data-testid="control-screen" data-stage={stage} data-risk={draft.risk} className="contents">
        <ViewHero
          eyebrow="Command plane"
          headline="Remote execution, with guardrails"
          description="Select a live client, compose the exact intent, inspect its payload, and dispatch only after the risk gate is satisfied."
          tone={draft.risk === 'danger' ? 'error' : undefined}
          metrics={
            <>
              <HeroMetric label="targets" value={clients.length} />
              <HeroMetric label="live sessions" value={snapshot?.liveSessions?.length ?? 0} />
              <HeroMetric
                label="stage"
                value={stage}
                tone={stage === 'preview' ? 'warn' : 'idle'}
              />
              <HeroMetric label="recent audit" value={auditEntries.length} />
            </>
          }
        />

        <div className="grid gap-4 2xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <div className="space-y-3">
            <Card>
              <CardHeader>
                <CardTitle>Command target</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <Label htmlFor="hq-control-client">Client</Label>
                <Select
                  id="hq-control-client"
                  value={targetId ?? ''}
                  onChange={(event) => {
                    useHqStore.getState().selectClient(event.target.value);
                    resetToCompose();
                  }}
                >
                  {clients.map((client) => (
                    <option key={client.clientId} value={client.clientId}>
                      {controlClientLabel(client, snapshot)}
                    </option>
                  ))}
                </Select>

                {targetClient !== null && (
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                    <span>
                      <strong className="font-medium text-foreground">kind</strong>{' '}
                      {targetClient.kind}
                    </span>
                    <span>
                      <strong className="font-medium text-foreground">host</strong>{' '}
                      {targetClient.hostname ?? 'unknown'}
                    </span>
                    <span>
                      <strong className="font-medium text-foreground">project</strong>{' '}
                      {targetClient.projectId}
                    </span>
                    <span>
                      <strong className="font-medium text-foreground">client</strong>{' '}
                      {shortId(targetClient.clientId)}
                    </span>
                    {targetSession !== undefined && (
                      <span>
                        <strong className="font-medium text-foreground">session</strong>{' '}
                        {shortId(targetSession.sessionId)} · {targetSession.agentCount} agents
                      </span>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Command type</CardTitle>
                <div className="ml-auto flex items-center gap-1.5 text-[10px] uppercase tracking-[0.09em]">
                  <span className="text-primary">1 compose</span>
                  <span className={stage === 'preview' ? 'text-primary' : 'text-muted-foreground'}>
                    2 preview
                  </span>
                  <span className={status !== null ? 'text-primary' : 'text-muted-foreground'}>
                    3 queued
                  </span>
                </div>
              </CardHeader>

              <CardContent className="space-y-2">
                <div className="flex flex-wrap gap-1.5">
                  {COMMAND_TYPES.map((candidate) => {
                    const candidateMeta = COMMAND_META[candidate];
                    const Icon = candidateMeta.icon;
                    const selected = candidate === type;
                    return (
                      <button
                        key={candidate}
                        type="button"
                        data-testid="control-type"
                        data-selected={selected}
                        title={candidateMeta.description}
                        onClick={() => chooseType(candidate)}
                        className={cn(
                          'inline-flex items-center gap-1.5 border px-2 py-1 text-[11px] transition-colors',
                          selected
                            ? candidateMeta.danger === true
                              ? 'border-destructive bg-destructive/10 text-destructive'
                              : 'border-primary bg-primary/10 text-primary'
                            : 'border-border text-muted-foreground hover:text-foreground',
                        )}
                      >
                        <Icon className="size-3" />
                        {candidateMeta.label}
                      </button>
                    );
                  })}
                </div>

                <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  {meta.danger === true && (
                    <TriangleAlert className="size-3 shrink-0 text-destructive" />
                  )}
                  {meta.description}
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="space-y-2">
                {(type === 'steer' || type === 'btw' || type === 'queue') && (
                  <>
                    <Label htmlFor="hq-control-recipient">
                      To — an agent address (<code>leader</code>, <code>leader@sessionTag</code>, or
                      a subagent id)
                    </Label>
                    <Input
                      id="hq-control-recipient"
                      value={steerTo}
                      placeholder="leader"
                      onChange={(event) => {
                        setSteerTo(event.target.value);
                        setHqControlPrefs({ steerTo: event.target.value });
                      }}
                    />
                    <Label htmlFor="hq-control-subject">Subject</Label>
                    <Input
                      id="hq-control-subject"
                      value={steerSubject}
                      onChange={(event) => {
                        setSteerSubject(event.target.value);
                        setHqControlPrefs({ steerSubject: event.target.value });
                      }}
                    />
                    <Label htmlFor="hq-control-body">Body</Label>
                    <Textarea
                      id="hq-control-body"
                      value={steerBody}
                      onChange={(event) => {
                        setSteerBody(event.target.value);
                        setHqControlPrefs({ steerBody: event.target.value });
                      }}
                    />
                  </>
                )}

                {type === 'abort' && (
                  <>
                    <Label htmlFor="hq-control-abort-target">Target</Label>
                    <Select
                      id="hq-control-abort-target"
                      value={abortTarget}
                      onChange={(event) => {
                        const next = event.target.value as 'leader' | 'fleet';
                        setAbortTarget(next);
                        setHqControlPrefs({ abortTarget: next });
                      }}
                    >
                      <option value="leader">leader (session leader)</option>
                      <option value="fleet">fleet (all subagents)</option>
                    </Select>
                    <DangerNote>
                      Abort is destructive. Dispatch requires typing <strong>ABORT</strong> in the
                      preview.
                    </DangerNote>
                  </>
                )}

                {type === 'spawn' && (
                  <>
                    <Label htmlFor="hq-control-spawn-role">Role</Label>
                    <Select
                      id="hq-control-spawn-role"
                      value={spawnRole}
                      onChange={(event) => {
                        setSpawnRole(event.target.value);
                        setHqControlPrefs({ spawnRole: event.target.value });
                      }}
                    >
                      {SPAWN_ROLES.map((role) => (
                        <option key={role} value={role}>
                          {role}
                        </option>
                      ))}
                    </Select>
                    <Label htmlFor="hq-control-spawn-task">Task (optional)</Label>
                    <Textarea
                      id="hq-control-spawn-task"
                      value={spawnTask}
                      placeholder="Describe the task…"
                      onChange={(event) => {
                        setSpawnTask(event.target.value);
                        setHqControlPrefs({ spawnTask: event.target.value });
                      }}
                    />
                  </>
                )}

                {type === 'run-command' && (
                  <>
                    <Label htmlFor="hq-control-run-command">Shell command</Label>
                    <Textarea
                      id="hq-control-run-command"
                      value={runCommand}
                      placeholder="pnpm test"
                      onChange={(event) => setRunCommand(event.target.value)}
                    />
                    <Label htmlFor="hq-control-run-cwd">
                      Working directory (optional — defaults to the agent’s project root)
                    </Label>
                    <Input
                      id="hq-control-run-cwd"
                      value={runCwd}
                      onChange={(event) => setRunCwd(event.target.value)}
                    />
                    <DangerNote>
                      The client must run with <code>--hq-allow-exec</code> and your token needs the{' '}
                      <code>control.execute</code> capability, or the server rejects this. Dispatch
                      requires typing <strong>RUN</strong> in the preview.
                    </DangerNote>
                  </>
                )}

                {type === 'broadcast' && (
                  <>
                    <Label htmlFor="hq-control-broadcast-subject">Subject</Label>
                    <Input
                      id="hq-control-broadcast-subject"
                      value={broadcastSubject}
                      onChange={(event) => {
                        setBroadcastSubject(event.target.value);
                        setHqControlPrefs({ broadcastSubject: event.target.value });
                      }}
                    />
                    <Label htmlFor="hq-control-broadcast-body">Body</Label>
                    <Textarea
                      id="hq-control-broadcast-body"
                      value={broadcastBody}
                      onChange={(event) => {
                        setBroadcastBody(event.target.value);
                        setHqControlPrefs({ broadcastBody: event.target.value });
                      }}
                    />
                  </>
                )}
              </CardContent>
            </Card>

            <Card className={draft.risk === 'danger' ? 'border-destructive/50' : undefined}>
              <CardHeader>
                <CardTitle>Dispatch gate</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <Badge tone={draft.risk === 'danger' ? 'error' : 'info'}>{draft.risk}</Badge>
                  <span className="min-w-0 flex-1 text-muted-foreground">{draft.summary}</span>
                  {draft.disabledReason !== null && (
                    <Badge tone="warn">{draft.disabledReason}</Badge>
                  )}
                </div>

                {stage === 'preview' ? (
                  <>
                    <div className="text-[10px] font-semibold uppercase tracking-[0.09em] text-muted-foreground">
                      payload preview
                    </div>
                    <pre className="overflow-x-auto border border-border bg-muted/30 p-2 font-mono text-[11px] leading-relaxed">
                      {JSON.stringify(
                        { clientId: targetId, type: draft.type, payload: draft.payload },
                        null,
                        2,
                      )}
                    </pre>

                    {confirmWord !== null && (
                      <>
                        <Label htmlFor="hq-control-confirm">Confirm destructive dispatch</Label>
                        <Input
                          id="hq-control-confirm"
                          value={confirmText}
                          placeholder={`Type ${confirmWord}`}
                          onChange={(event) => setConfirmText(event.target.value)}
                          className="font-mono"
                        />
                      </>
                    )}

                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant={draft.risk === 'danger' ? 'destructive' : 'default'}
                        disabled={busy || !canDispatch}
                        onClick={() => void dispatch()}
                        title="Ctrl+Enter"
                      >
                        {busy ? 'Dispatching…' : 'Dispatch command'}
                      </Button>
                      <Button variant="outline" disabled={busy} onClick={resetToCompose}>
                        Back to compose
                      </Button>
                    </div>
                  </>
                ) : (
                  <Button
                    disabled={!canPreview}
                    onClick={() => {
                      setStage('preview');
                      setStatus(null);
                      setError(null);
                    }}
                    title="Ctrl+Enter"
                  >
                    Preview command
                  </Button>
                )}

                {status !== null && <Badge tone="active">{status}</Badge>}
                {error !== null && <Badge tone="error">{error}</Badge>}
              </CardContent>
            </Card>

            <Mono>Ctrl+Enter advances one stage — it never skips the preview.</Mono>
          </div>

          <CommandAuditRail
            entries={auditEntries}
            loading={auditLoading}
            error={auditError}
            selectedClientId={targetId}
            highlightCommandId={lastDispatchedId}
            onRefresh={() => void loadAudit()}
          />
        </div>
      </div>
    </ViewShell>
  );
}
