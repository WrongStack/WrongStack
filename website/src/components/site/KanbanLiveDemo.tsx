import { LayoutGroup, motion, useReducedMotion } from 'framer-motion';
import {
  Activity,
  CheckCircle2,
  CircleDot,
  Clock3,
  GitPullRequest,
  Pause,
  Play,
  Radio,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Users,
  Zap,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

type DemoColumnId = 'backlog' | 'todo' | 'running' | 'preview' | 'done';
type DemoPriority = 'critical' | 'high' | 'medium' | 'low';
type AgentState = 'idle' | 'queued' | 'running' | 'reviewing' | 'returned';

type DemoAgent = {
  id: string;
  name: string;
  role: string;
  initials: string;
  tone: string;
};

type DemoTask = {
  id: string;
  title: string;
  summary: string;
  priority: DemoPriority;
  labels: string[];
  stage: number;
  agentId: string;
  crewIds: string[];
  checks: number;
};

type DemoEvent = {
  id: number;
  text: string;
  meta: string;
  tone: 'brand' | 'amber' | 'green' | 'violet';
};

const columns: Array<{
  id: DemoColumnId;
  label: string;
  taskStatus: string;
  assignmentStatus: string;
  wip?: number;
  dot: string;
  accent: string;
}> = [
  {
    id: 'backlog',
    label: 'Backlog',
    taskStatus: 'pending',
    assignmentStatus: 'unassigned',
    dot: 'bg-zinc-500',
    accent: 'text-zinc-400',
  },
  {
    id: 'todo',
    label: 'To do',
    taskStatus: 'ready',
    assignmentStatus: 'queued',
    dot: 'bg-sky-400',
    accent: 'text-sky-300',
  },
  {
    id: 'running',
    label: 'Running',
    taskStatus: 'in_progress',
    assignmentStatus: 'running',
    wip: 3,
    dot: 'bg-brand-2',
    accent: 'text-brand-2',
  },
  {
    id: 'preview',
    label: 'Preview',
    taskStatus: 'review',
    assignmentStatus: 'running',
    dot: 'bg-violet-400',
    accent: 'text-violet-300',
  },
  {
    id: 'done',
    label: 'Done',
    taskStatus: 'completed',
    assignmentStatus: 'completed',
    dot: 'bg-emerald-400',
    accent: 'text-emerald-300',
  },
];

const agents: DemoAgent[] = [
  {
    id: 'frontend',
    name: 'Vega',
    role: 'frontend',
    initials: 'VG',
    tone: 'border-cyan-300/30 bg-cyan-300/10 text-cyan-200',
  },
  {
    id: 'backend',
    name: 'Turing',
    role: 'backend',
    initials: 'TR',
    tone: 'border-brand-2/30 bg-brand-2/10 text-brand-2',
  },
  {
    id: 'test',
    name: 'Curie',
    role: 'test',
    initials: 'CR',
    tone: 'border-emerald-300/30 bg-emerald-300/10 text-emerald-200',
  },
  {
    id: 'reviewer',
    name: 'Ada',
    role: 'reviewer',
    initials: 'AD',
    tone: 'border-violet-300/30 bg-violet-300/10 text-violet-200',
  },
  {
    id: 'security',
    name: 'Lin',
    role: 'security-reviewer',
    initials: 'LN',
    tone: 'border-rose-300/30 bg-rose-300/10 text-rose-200',
  },
  {
    id: 'architect',
    name: 'Nash',
    role: 'architect',
    initials: 'NS',
    tone: 'border-sky-300/30 bg-sky-300/10 text-sky-200',
  },
];

const taskSeeds: DemoTask[] = [
  {
    id: 'KAN-184',
    title: 'Add optimistic card movement',
    summary: 'Keep board state responsive while the durable write is confirmed.',
    priority: 'high',
    labels: ['webui', 'state'],
    stage: 2,
    agentId: 'frontend',
    crewIds: ['reviewer', 'test'],
    checks: 3,
  },
  {
    id: 'KAN-191',
    title: 'Harden stale lease recovery',
    summary: 'Release expired assignments without allowing a duplicate claim.',
    priority: 'critical',
    labels: ['queue', 'safety'],
    stage: 3,
    agentId: 'backend',
    crewIds: ['security', 'test'],
    checks: 4,
  },
  {
    id: 'KAN-203',
    title: 'Render queue health signals',
    summary: 'Expose ready, heartbeat-due and stale assignment counts.',
    priority: 'medium',
    labels: ['telemetry'],
    stage: 1,
    agentId: 'frontend',
    crewIds: ['reviewer'],
    checks: 2,
  },
  {
    id: 'KAN-207',
    title: 'Verify cost ceiling enforcement',
    summary: 'Fail safely when a worker crosses the task-local cost budget.',
    priority: 'high',
    labels: ['policy', 'test'],
    stage: 4,
    agentId: 'test',
    crewIds: ['backend'],
    checks: 3,
  },
  {
    id: 'KAN-214',
    title: 'Sync SDD graph dependencies',
    summary: 'Project graph edges onto the board without introducing cycles.',
    priority: 'high',
    labels: ['sdd', 'graph'],
    stage: 1,
    agentId: 'architect',
    crewIds: ['backend', 'test'],
    checks: 4,
  },
  {
    id: 'KAN-219',
    title: 'Design WIP limit feedback',
    summary: 'Show why a card cannot enter a capacity-limited column.',
    priority: 'low',
    labels: ['ux'],
    stage: 0,
    agentId: 'frontend',
    crewIds: ['reviewer'],
    checks: 2,
  },
  {
    id: 'KAN-225',
    title: 'Add board activity stream',
    summary: 'Correlate claims, dispatches, heartbeats and structured results.',
    priority: 'medium',
    labels: ['events', 'audit'],
    stage: 2,
    agentId: 'backend',
    crewIds: ['frontend', 'reviewer'],
    checks: 3,
  },
];

const priorityStyles: Record<DemoPriority, string> = {
  critical: 'border-rose-400/25 bg-rose-400/10 text-rose-200',
  high: 'border-brand/25 bg-brand/10 text-brand',
  medium: 'border-brand-2/25 bg-brand-2/10 text-brand-2',
  low: 'border-white/10 bg-white/[0.035] text-zinc-400',
};

const eventToneStyles: Record<DemoEvent['tone'], string> = {
  brand: 'bg-cyan-300',
  amber: 'bg-brand-2',
  green: 'bg-emerald-300',
  violet: 'bg-violet-300',
};

const agentStateStyles: Record<AgentState, { label: string; dot: string; text: string }> = {
  idle: { label: 'idle', dot: 'bg-zinc-600', text: 'text-zinc-500' },
  queued: { label: 'queued', dot: 'bg-sky-300', text: 'text-sky-300' },
  running: { label: 'executing', dot: 'bg-brand-2', text: 'text-brand-2' },
  reviewing: { label: 'reviewing', dot: 'bg-violet-300', text: 'text-violet-300' },
  returned: { label: 'returned', dot: 'bg-emerald-300', text: 'text-emerald-300' },
};

function cloneInitialTasks() {
  return taskSeeds.map((task) => ({
    ...task,
    labels: [...task.labels],
    crewIds: [...task.crewIds],
  }));
}

function taskProgress(task: DemoTask) {
  return [0, 14, 56, 88, 100][task.stage] ?? 0;
}

function assignmentStatus(stage: number) {
  return ['unassigned', 'queued', 'running', 'running', 'completed'][stage] ?? 'unassigned';
}

function eventForMove(task: DemoTask, nextStage: number): Omit<DemoEvent, 'id'> {
  const agent = agents.find((item) => item.id === task.agentId);
  if (nextStage === 1) {
    return {
      text: `${task.id} became dependency-ready`,
      meta: `queued for ${agent?.role ?? 'specialist'}`,
      tone: 'brand',
    };
  }
  if (nextStage === 2) {
    return {
      text: `Director dispatched ${agent?.name ?? 'worker'}`,
      meta: `${task.id} · lease 05:00 · attempt 1/3`,
      tone: 'amber',
    };
  }
  if (nextStage === 3) {
    return {
      text: `${task.id} opened a preview`,
      meta: `${task.crewIds.length} review agents joined`,
      tone: 'violet',
    };
  }
  return {
    text: `${task.id} passed ${task.checks}/${task.checks} checks`,
    meta: 'structured result written to board',
    tone: 'green',
  };
}

function agentState(agentId: string, tasks: DemoTask[]): { state: AgentState; task?: DemoTask } {
  const running = tasks.find((task) => task.agentId === agentId && task.stage === 2);
  if (running) return { state: 'running', task: running };
  const reviewing = tasks.find((task) => task.stage === 3 && task.crewIds.includes(agentId));
  if (reviewing) return { state: 'reviewing', task: reviewing };
  const queued = tasks.find((task) => task.agentId === agentId && task.stage === 1);
  if (queued) return { state: 'queued', task: queued };
  const returned = tasks.find((task) => task.agentId === agentId && task.stage === 4);
  if (returned) return { state: 'returned', task: returned };
  return { state: 'idle' };
}

function AgentAvatar({ agent, compact = false }: { agent: DemoAgent; compact?: boolean }) {
  return (
    <span
      className={cn(
        'grid shrink-0 place-items-center rounded-full border font-mono font-black',
        compact ? 'size-6 text-[7px]' : 'size-8 text-[8px]',
        agent.tone,
      )}
      title={`${agent.name} · ${agent.role}`}
    >
      {agent.initials}
    </span>
  );
}

function TaskCard({ task, reducedMotion }: { task: DemoTask; reducedMotion: boolean }) {
  const column = columns[task.stage] ?? columns[0];
  const primaryAgent = agents.find((agent) => agent.id === task.agentId);
  const crew = task.crewIds
    .map((agentId) => agents.find((agent) => agent.id === agentId))
    .filter((agent): agent is DemoAgent => Boolean(agent));
  const progress = taskProgress(task);

  return (
    <motion.article
      layout={!reducedMotion}
      layoutId={`kanban-task-${task.id}`}
      initial={reducedMotion ? false : { opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ layout: { duration: 0.42, ease: [0.22, 1, 0.36, 1] } }}
      className="rounded-xl border border-white/[0.09] bg-[#171a23] p-3.5 shadow-[0_20px_45px_-35px_rgba(0,0,0,.95)]"
    >
      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-[8px] font-black uppercase tracking-[0.14em] text-zinc-500">
          {task.id}
        </span>
        <span
          className={cn(
            'rounded-full border px-2 py-0.5 font-mono text-[7px] font-black uppercase tracking-wider',
            priorityStyles[task.priority],
          )}
        >
          {task.priority}
        </span>
      </div>
      <h4 className="mt-3 text-[13px] font-black leading-5 tracking-[-0.02em] text-zinc-100">
        {task.title}
      </h4>
      <p className="mt-1.5 line-clamp-2 text-xs leading-[1.55] text-zinc-500">{task.summary}</p>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {task.labels.map((label) => (
          <span
            key={label}
            className="rounded-md border border-white/[0.07] bg-white/[0.025] px-1.5 py-1 font-mono text-[7px] font-bold text-zinc-500"
          >
            {label}
          </span>
        ))}
      </div>

      {task.stage >= 2 && (
        <div className="mt-3">
          <div className="flex items-center justify-between font-mono text-[7px] font-bold uppercase tracking-wider text-zinc-600">
            <span>{task.stage === 3 ? 'review evidence' : 'task progress'}</span>
            <span className={column.accent}>{progress}%</span>
          </div>
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-white/[0.06]">
            <motion.div
              className={cn('h-full rounded-full', column.dot)}
              initial={false}
              animate={{ width: `${progress}%` }}
              transition={{ duration: reducedMotion ? 0 : 0.45, ease: 'easeOut' }}
            />
          </div>
        </div>
      )}

      <div className="mt-3.5 flex items-center gap-2 border-t border-white/[0.07] pt-3">
        {task.stage === 0 || !primaryAgent ? (
          <>
            <Clock3 className="size-3 text-zinc-600" />
            <span className="font-mono text-[8px] text-zinc-600">dependency scan pending</span>
          </>
        ) : (
          <>
            <AgentAvatar agent={primaryAgent} compact />
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-black text-zinc-300">
                {primaryAgent.name} · {primaryAgent.role}
              </div>
              <div className="mt-0.5 flex items-center gap-1.5 font-mono text-[7px] uppercase tracking-wider text-zinc-600">
                <span className={cn('size-1.5 rounded-full', column.dot)} />
                assignment / {assignmentStatus(task.stage)}
              </div>
            </div>
            {task.stage >= 3 && crew.length > 0 && (
              <div className="flex -space-x-1.5">
                <span className="sr-only">{crew.length} collaborating agents</span>
                {crew.map((agent) => (
                  <AgentAvatar key={agent.id} agent={agent} compact />
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {task.stage === 2 && (
        <div className="mt-2 flex items-center justify-between font-mono text-[7px] text-zinc-600">
          <span className="flex items-center gap-1">
            <Radio className="size-2.5 text-emerald-300" /> heartbeat 8s ago
          </span>
          <span>lease 04:41</span>
        </div>
      )}
      {task.stage === 4 && (
        <div className="mt-2 flex items-center gap-1.5 font-mono text-[7px] font-bold text-emerald-300">
          <CheckCircle2 className="size-3" /> {task.checks}/{task.checks} checks · result attached
        </div>
      )}
    </motion.article>
  );
}

export function KanbanLiveDemo() {
  const reducedMotionPreference = useReducedMotion();
  const reducedMotion = Boolean(reducedMotionPreference);
  const [tasks, setTasks] = useState<DemoTask[]>(cloneInitialTasks);
  const [paused, setPaused] = useState(false);
  const [cycle, setCycle] = useState(42);
  const [events, setEvents] = useState<DemoEvent[]>([
    {
      id: 3,
      text: 'KAN-191 opened a preview',
      meta: 'security-reviewer + test joined',
      tone: 'violet',
    },
    {
      id: 2,
      text: 'Director dispatched Vega',
      meta: 'KAN-184 · frontend · lease 05:00',
      tone: 'amber',
    },
    {
      id: 1,
      text: 'KAN-214 became dependency-ready',
      meta: 'queued for architect',
      tone: 'brand',
    },
  ]);
  const eventId = useRef(4);

  useEffect(() => {
    if (paused || reducedMotion) return;

    const timer = window.setTimeout(() => {
      const runningCount = tasks.filter((task) => task.stage === 2).length;
      const candidates = tasks.filter(
        (task) => task.stage < columns.length - 1 && !(task.stage === 1 && runningCount >= 3),
      );
      if (candidates.length === 0) {
        const nextCycle = cycle + 1;
        setCycle(nextCycle);
        setEvents((currentEvents) =>
          (
            [
              {
                id: eventId.current++,
                text: `Sprint ${cycle} archived`,
                meta: `sample sprint ${nextCycle} seeded from backlog`,
                tone: 'green',
              },
              ...currentEvents,
            ] as DemoEvent[]
          ).slice(0, 4),
        );
        setTasks(cloneInitialTasks().map((task) => ({ ...task, stage: Math.min(task.stage, 1) })));
        return;
      }

      const selected = candidates[Math.floor(Math.random() * candidates.length)];
      if (!selected) return;
      const nextStage = selected.stage + 1;
      const nextEvent = eventForMove(selected, nextStage);
      setEvents((currentEvents) =>
        [{ ...nextEvent, id: eventId.current++ }, ...currentEvents].slice(0, 4),
      );
      setTasks((current) =>
        current.map((task) => (task.id === selected.id ? { ...task, stage: nextStage } : task)),
      );
    }, 2400);

    return () => window.clearTimeout(timer);
  }, [cycle, paused, reducedMotion, tasks]);

  const metrics = useMemo(() => {
    const running = tasks.filter((task) => task.stage === 2).length;
    const reviewing = tasks.filter((task) => task.stage === 3).length;
    const done = tasks.filter((task) => task.stage === 4).length;
    const liveAgentIds = new Set<string>();
    for (const task of tasks) {
      if (task.stage >= 1 && task.stage < 4) liveAgentIds.add(task.agentId);
      if (task.stage === 3) {
        task.crewIds.forEach((id) => {
          liveAgentIds.add(id);
        });
      }
    }
    return { running, reviewing, done, agents: liveAgentIds.size };
  }, [tasks]);

  const reset = () => {
    setTasks(cloneInitialTasks());
    setCycle(42);
    setEvents((currentEvents) =>
      (
        [
          {
            id: eventId.current++,
            text: 'Demo board reset',
            meta: 'sample assignments restored',
            tone: 'brand',
          },
          ...currentEvents,
        ] as DemoEvent[]
      ).slice(0, 4),
    );
  };

  return (
    <section className="border-b border-line bg-ink px-4 py-16 text-white sm:px-6 sm:py-24 lg:px-10 lg:py-28">
      <div className="mx-auto max-w-[1500px]">
        <div className="mb-9 grid gap-5 lg:grid-cols-[0.8fr_1.2fr] lg:items-end">
          <div>
            <div className="flex items-center gap-2 font-mono text-xs font-black uppercase tracking-[0.2em] text-brand">
              <Activity className="size-3.5" /> Animated Web UI demo
            </div>
            <h2 className="mt-4 max-w-3xl text-3xl font-black leading-[1.04] tracking-[-0.03em] sm:text-5xl">
              Watch durable work become a live fleet.
            </h2>
          </div>
          <p className="max-w-2xl text-base leading-7 text-zinc-400 lg:justify-self-end">
            Sample tasks move through custom board columns while task status, assignment status,
            atomic dispatch, heartbeats and multi-agent review remain visible as separate signals.
          </p>
        </div>

        <div className="overflow-hidden rounded-[26px] border border-white/10 bg-[#0b0d12] shadow-2xl shadow-black/30">
          <div className="border-b border-white/[0.08] px-4 py-4 sm:px-5">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <span className="grid size-9 place-items-center rounded-xl border border-cyan-300/20 bg-cyan-300/10 text-cyan-300">
                  <GitPullRequest className="size-4" />
                </span>
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="font-mono text-xs font-black uppercase tracking-[0.16em] text-zinc-200">
                      Product launch / Sprint {cycle}
                    </h3>
                    {!paused && !reducedMotion && (
                      <motion.span
                        animate={{ opacity: [0.35, 1, 0.35] }}
                        transition={{ duration: 1.8, repeat: Number.POSITIVE_INFINITY }}
                        className="size-1.5 rounded-full bg-emerald-300 shadow-[0_0_10px_rgba(110,231,183,.75)]"
                      />
                    )}
                  </div>
                  <p className="mt-1 font-mono text-[8px] text-zinc-600">
                    project board · atomic queue · sample data
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setPaused((value) => !value)}
                  aria-pressed={paused}
                  disabled={reducedMotion}
                  className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.035] px-3 py-2 font-mono text-[8px] font-black uppercase tracking-wider text-zinc-300 transition-colors hover:border-cyan-300/30 hover:text-cyan-200 disabled:cursor-not-allowed disabled:opacity-45"
                >
                  {paused || reducedMotion ? (
                    <Play className="size-3" />
                  ) : (
                    <Pause className="size-3" />
                  )}
                  {reducedMotion ? 'Motion reduced' : paused ? 'Resume' : 'Pause'}
                </button>
                <button
                  type="button"
                  onClick={reset}
                  className="grid size-8 place-items-center rounded-lg border border-white/10 text-zinc-500 transition-colors hover:border-brand-2/30 hover:text-brand-2"
                  aria-label="Reset demo board"
                >
                  <RotateCcw className="size-3.5" />
                </button>
              </div>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-white/[0.07] bg-white/[0.07] sm:grid-cols-4">
              {[
                ['live agents', metrics.agents, Users, 'text-cyan-300'],
                ['running', metrics.running, Zap, 'text-brand-2'],
                ['in preview', metrics.reviewing, ShieldCheck, 'text-violet-300'],
                ['completed', metrics.done, CheckCircle2, 'text-emerald-300'],
              ].map(([label, value, Icon, tone]) => {
                const MetricIcon = Icon as typeof Users;
                return (
                  <div
                    key={String(label)}
                    className="flex items-center gap-2.5 bg-[#11141c] px-3 py-2.5"
                  >
                    <MetricIcon className={cn('size-3.5', String(tone))} />
                    <strong className="font-mono text-xs text-zinc-200">{String(value)}</strong>
                    <span className="font-mono text-[7px] font-bold uppercase tracking-wider text-zinc-600">
                      {String(label)}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="border-b border-white/[0.08] px-4 py-3 sm:px-5">
            <div className="no-scrollbar flex gap-2 overflow-x-auto pb-1">
              {agents.map((agent) => {
                const current = agentState(agent.id, tasks);
                const stateStyle = agentStateStyles[current.state];
                return (
                  <div
                    key={agent.id}
                    className="flex min-w-[190px] items-center gap-2.5 rounded-xl border border-white/[0.07] bg-white/[0.025] px-3 py-2.5"
                  >
                    <AgentAvatar agent={agent} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <strong className="text-xs text-zinc-300">{agent.name}</strong>
                        <span className={cn('font-mono text-[7px] uppercase', stateStyle.text)}>
                          {stateStyle.label}
                        </span>
                      </div>
                      <div className="mt-0.5 truncate font-mono text-[7px] text-zinc-600">
                        {current.task ? `${current.task.id} · ${agent.role}` : agent.role}
                      </div>
                    </div>
                    <span className={cn('size-1.5 rounded-full', stateStyle.dot)} />
                  </div>
                );
              })}
            </div>
          </div>

          <LayoutGroup id="kanban-live-demo">
            <div className="no-scrollbar overflow-x-auto">
              <div className="grid min-w-[1320px] grid-cols-5 gap-px bg-white/[0.07]">
                {columns.map((column, columnIndex) => {
                  const columnTasks = tasks.filter((task) => task.stage === columnIndex);
                  return (
                    <div key={column.id} className="min-h-[560px] bg-[#10131a] p-3">
                      <div className="mb-3 rounded-xl border border-white/[0.07] bg-white/[0.025] p-3">
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex items-center gap-2">
                            <span className={cn('size-2 rounded-full', column.dot)} />
                            <h3 className="text-xs font-black text-zinc-200">{column.label}</h3>
                          </div>
                          <span className="grid size-5 place-items-center rounded-full border border-white/10 font-mono text-[8px] font-black text-zinc-500">
                            {columnTasks.length}
                          </span>
                        </div>
                        <div className="mt-2 flex items-center justify-between font-mono text-[7px] uppercase tracking-wider text-zinc-600">
                          <span>task / {column.taskStatus}</span>
                          <span>
                            {column.wip
                              ? `WIP ${columnTasks.length}/${column.wip}`
                              : `assignment / ${column.assignmentStatus}`}
                          </span>
                        </div>
                      </div>
                      <div className="space-y-2.5">
                        {columnTasks.map((task) => (
                          <TaskCard key={task.id} task={task} reducedMotion={reducedMotion} />
                        ))}
                        {columnTasks.length === 0 && (
                          <div className="grid min-h-28 place-items-center rounded-xl border border-dashed border-white/[0.07] text-center">
                            <div>
                              <CircleDot className="mx-auto size-4 text-zinc-700" />
                              <p className="mt-2 font-mono text-[8px] text-zinc-700">
                                waiting for task
                              </p>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </LayoutGroup>

          <div className="grid border-t border-white/[0.08] lg:grid-cols-[1fr_310px]">
            <div className="border-b border-white/[0.08] px-4 py-4 lg:border-b-0 lg:border-r sm:px-5">
              <div className="flex items-center justify-between">
                <span className="font-mono text-[8px] font-black uppercase tracking-[0.16em] text-zinc-500">
                  Live board activity
                </span>
                <span className="flex items-center gap-1.5 font-mono text-[7px] text-zinc-600">
                  <Radio className="size-3 text-emerald-300" /> event stream
                </span>
              </div>
              <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                {events.map((event) => (
                  <motion.div
                    key={event.id}
                    initial={reducedMotion ? false : { opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="rounded-lg border border-white/[0.07] bg-white/[0.025] p-3"
                  >
                    <div className="flex items-start gap-2">
                      <span
                        className={cn(
                          'mt-1 size-1.5 shrink-0 rounded-full',
                          eventToneStyles[event.tone],
                        )}
                      />
                      <div>
                        <p className="text-xs font-bold leading-4 text-zinc-300">{event.text}</p>
                        <p className="mt-1 font-mono text-[7px] leading-3 text-zinc-600">
                          {event.meta}
                        </p>
                      </div>
                    </div>
                  </motion.div>
                ))}
              </div>
            </div>
            <div className="flex flex-col justify-center px-4 py-4 sm:px-5">
              <div className="flex items-center gap-2 font-mono text-[8px] font-black uppercase tracking-[0.15em] text-brand-2">
                <Sparkles className="size-3.5" /> Director queue
              </div>
              <p className="mt-2 text-xs leading-5 text-zinc-500">
                Dependency-ready cards are claimed atomically, then routed by role, model, tools and
                capability policy.
              </p>
              <code className="mt-3 rounded-lg border border-white/[0.07] bg-black/20 px-3 py-2 font-mono text-[8px] text-cyan-300">
                kanban_queue · awaitCompletion=true
              </code>
            </div>
          </div>
        </div>

        <div className="mt-4 flex flex-col gap-2 text-xs leading-5 text-zinc-500 sm:flex-row sm:items-center sm:justify-between">
          <p>Illustrative local simulation. No project data is read or mutated.</p>
          <p className="font-mono text-[8px] uppercase tracking-wider text-zinc-600">
            task status ≠ assignment status · sample agents and metrics
          </p>
        </div>
      </div>
    </section>
  );
}
