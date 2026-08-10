import type {
  KanbanBoard,
  KanbanBoardPresence,
  KanbanEvent,
  KanbanManualActivityKind,
  KanbanManualActivityOutcome,
  KanbanModelRoutingMode,
  KanbanTask,
} from '@wrongstack/kanban';
import {
  ChevronDown,
  Copy,
  Maximize2,
  Minimize2,
  MoveRight,
  Save,
  Send,
  ShieldCheck,
  UserPlus,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { useKanbanMeta } from '@/hooks/useKanbanMeta';
import { useProviderModels } from '@/hooks/useProviderModels';
import { useScrollPosition } from '@/hooks/useScrollPosition';
import { useAppTranslation } from '@/i18n';
import { kanbanMetadataText } from '@/lib/kanban-metadata';
import { cn } from '@/lib/utils';
import { ChipMultiSelect } from './ChipMultiSelect';
import { AgentRunPanel } from './KanbanAgentRunPanel.js';
import { KanbanBoundaryEditor } from './KanbanBoundaryEditor';
import { KanbanDecompositionPanel } from './KanbanDecompositionPanel';
import { type RunLink, RunTaskControls } from './KanbanRunControls.js';
import { KanbanTaskActivityRecorder } from './KanbanTaskActivityRecorder';
import { KanbanTaskCompletionChecks } from './KanbanTaskCompletionChecks';
import { columnTitle, Field, Metric, SelectField } from './KanbanTaskFields.js';
import { KNOWN_CAPABILITIES, KNOWN_ROLES } from './KanbanTaskOptions';
import { ModelPicker } from './ModelPicker';
import { TaskActivityTimeline } from './TaskActivityTimeline';
import { TaskExecutionAttempts } from './TaskExecutionAttempts';
import { TaskIntelligencePanel } from './TaskIntelligencePanel';
import { TaskRiskPanel } from './TaskRiskPanel';
import { TaskVerificationSection } from './TaskVerificationSection';

export function KanbanTaskInspector({
  boards,
  board,
  task,
  runLink,
  onClose,
  onSelectTask,
  sendKanban,
  sendRaw,
  activityEvents,
  activityPresence,
  activityLoading,
  activityError,
  activitySessionId,
  refreshActivity,
}: {
  boards: Array<{ id: string; title: string }>;
  board: KanbanBoard | null;
  task: KanbanTask | null;
  runLink: RunLink | null;
  onClose: () => void;
  onSelectTask: (id: string) => void;
  sendKanban: (type: `kanban.${string}`, payload?: Record<string, unknown>) => void;
  sendRaw: (type: string, payload?: Record<string, unknown>) => void;
  activityEvents: KanbanEvent[];
  activityPresence?: KanbanBoardPresence[] | undefined;
  activityLoading: boolean;
  activityError: string | null;
  activitySessionId?: string | undefined;
  refreshActivity: () => void;
}) {
  const { t } = useAppTranslation();
  const [agentId, setAgentId] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [routingMode, setRoutingMode] = useState<KanbanModelRoutingMode>('session');
  const [fallbackProfile, setFallbackProfile] = useState('');
  const [fallbackModels, setFallbackModels] = useState<string[]>([]);
  const [skills, setSkills] = useState<string[]>([]);
  const [tools, setTools] = useState<string[]>([]);
  const [allowedCapabilities, setAllowedCapabilities] = useState<string[]>([]);
  const [targetBoardId, setTargetBoardId] = useState('');
  // Real provider/model catalogue — the user's saved providers and their live
  // model lists. Only fetches while a task is selected (the panel is open).
  const modelCandidates = useProviderModels(Boolean(task));
  // Real registered tools + the live session provider/model (the dispatch
  // fallback so nothing has to be typed by hand).
  const meta = useKanbanMeta(Boolean(task));
  const sessionProvider = kanbanMetadataText(meta.sessionProvider);
  const sessionModel = kanbanMetadataText(meta.sessionModel);
  // Scroll-position hook must be called unconditionally — calling it inside
  // JSX within the {task ? … : …} ternary violates the Rules of Hooks
  // (React error 310) when task toggles between null and non-null.
  const inspectorScrollRef = useScrollPosition<HTMLDivElement>(
    'kanban-task-inspector',
    Boolean(task),
  );
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [status, setStatus] = useState<KanbanTask['status']>('pending');
  const [transitionComment, setTransitionComment] = useState('');
  const [transitionAction, setTransitionAction] = useState('');
  const [transitionAttachmentUrl, setTransitionAttachmentUrl] = useState('');
  const [priority, setPriority] = useState<KanbanTask['priority']>('medium');
  const [taskType, setTaskType] = useState<NonNullable<KanbanTask['type']>>('chore');
  const [labelsText, setLabelsText] = useState('');
  const [dependsOn, setDependsOn] = useState<string[]>([]);
  const [chainMembers, setChainMembers] = useState<string[]>([]);
  const [enforceChainDependencies, setEnforceChainDependencies] = useState(false);
  const [estimatedHours, setEstimatedHours] = useState('');
  const [actualHours, setActualHours] = useState('');
  const [retryPolicy, setRetryPolicy] = useState<NonNullable<KanbanTask['retryPolicy']>>('off');
  const [costCeilingUsd, setCostCeilingUsd] = useState('');
  const [maxAttempts, setMaxAttempts] = useState('');
  const [newCheck, setNewCheck] = useState('');
  const [newNote, setNewNote] = useState('');
  const [newActivityDetails, setNewActivityDetails] = useState('');
  const [newActivityKind, setNewActivityKind] = useState<KanbanManualActivityKind>('observation');
  const [newActivityOutcome, setNewActivityOutcome] =
    useState<KanbanManualActivityOutcome>('unknown');
  const [changeReason, setChangeReason] = useState('');

  useEffect(() => {
    const assignmentProvider = kanbanMetadataText(task?.assignment?.provider);
    const assignmentModel = kanbanMetadataText(task?.assignment?.model);
    setAgentId(
      kanbanMetadataText(task?.assignment?.agentId) ??
        kanbanMetadataText(task?.assignedAgent) ??
        '',
    );
    setName(kanbanMetadataText(task?.assignment?.name) ?? '');
    setRole(kanbanMetadataText(task?.assignment?.role) ?? '');
    setProvider(assignmentProvider ?? '');
    setModel(assignmentModel ?? '');
    setRoutingMode(
      task?.assignment?.modelRouting ??
        (assignmentProvider || assignmentModel ? 'fixed' : 'session'),
    );
    setFallbackProfile(kanbanMetadataText(task?.assignment?.fallbackProfile) ?? '');
    setFallbackModels(task?.assignment?.fallbackModels ?? []);
    setSkills(task?.assignment?.skills ?? []);
    setTools(task?.assignment?.tools ?? []);
    setAllowedCapabilities(task?.assignment?.allowedCapabilities ?? []);
    setTargetBoardId(boards.find((candidate) => candidate.id !== board?.id)?.id ?? '');
    setTitle(task?.title ?? '');
    setDescription(task?.description ?? '');
    setDueDate(task?.dueDate ?? '');
    setStatus(task?.status ?? 'pending');
    setTransitionComment('');
    setTransitionAction('');
    setTransitionAttachmentUrl('');
    setPriority(task?.priority ?? 'medium');
    setTaskType(task?.type ?? 'chore');
    setLabelsText(task?.labels?.join(', ') ?? '');
    setDependsOn(task?.dependsOn ?? []);
    setChainMembers(
      task?.chain && board
        ? board.tasks
            .filter((candidate) => candidate.chain?.chainId === task.chain?.chainId)
            .sort((a, b) => (a.chain?.order ?? 0) - (b.chain?.order ?? 0))
            .map((candidate) => candidate.id)
        : task
          ? [task.id]
          : [],
    );
    setEnforceChainDependencies(false);
    setEstimatedHours(task?.estimatedHours?.toString() ?? '');
    setActualHours(task?.actualHours?.toString() ?? '');
    setRetryPolicy(task?.retryPolicy ?? task?.assignment?.retryPolicy ?? 'off');
    setCostCeilingUsd((task?.costCeilingUsd ?? task?.assignment?.costCeilingUsd)?.toString() ?? '');
    setMaxAttempts(task?.assignment?.maxAttempts?.toString() ?? '');
    setNewCheck('');
    setNewNote('');
    setNewActivityDetails('');
    setNewActivityKind('observation');
    setNewActivityOutcome('unknown');
    setChangeReason('');
    // Hydrate on IDENTITY, not on object churn. The mount site keys this
    // component on the task id, so a fresh `boards`/`task` object for the same
    // task no longer resets the form the user is typing into.
  }, [board?.id, task?.id]);

  const payload = (action: 'assign' | 'dispatch') => ({
    boardId: board?.id,
    taskId: task?.id,
    ...(agentId.trim() ? { agentId: agentId.trim() } : {}),
    ...(name.trim() ? { name: name.trim() } : {}),
    ...(role.trim() ? { role: role.trim() } : {}),
    modelRouting: routingMode,
    ...(routingMode === 'fixed' && provider.trim() ? { provider: provider.trim() } : {}),
    ...(routingMode === 'fixed' && model.trim() ? { model: model.trim() } : {}),
    ...(routingMode === 'fallback_profile' && fallbackProfile.trim()
      ? { fallbackProfile: fallbackProfile.trim() }
      : {}),
    fallbackModels,
    skills,
    tools,
    allowedCapabilities,
    ...(maxAttempts ? { maxAttempts: Number(maxAttempts) } : {}),
    ...(costCeilingUsd ? { costCeilingUsd: Number(costCeilingUsd) } : {}),
    retryPolicy,
    activityNote:
      changeReason.trim() ||
      `${t('activity:kanban.activityNoteTemplate', {
        action: action === 'dispatch' ? t('activity:kanban.dispatched') : t('activity:kanban.assigned'),
        target: name.trim() || agentId.trim() || role.trim() || t('activity:kanban.configuredAgentRoute'),
      })}`,
  });

  const saveDetails = () => {
    if (!board || !task || !title.trim()) return;
    sendKanban('kanban.task.update', {
      boardId: board.id,
      taskId: task.id,
      title: title.trim(),
      description,
      dueDate: dueDate || null,
      ...(board.lifecycle?.mode !== 'managed' ? { status } : {}),
      priority,
      type: taskType,
      labels: labelsText
        .split(',')
        .map((label) => label.trim())
        .filter(Boolean),
      dependsOn,
      ...(task.chain && chainMembers.length <= 1 ? { chain: null } : {}),
      estimatedHours: estimatedHours ? Number(estimatedHours) : 0,
      actualHours: actualHours ? Number(actualHours) : 0,
      retryPolicy,
      costCeilingUsd: costCeilingUsd ? Number(costCeilingUsd) : null,
      activityNote: changeReason.trim() || 'Task contract edited in WebUI.',
    });
    if (chainMembers.length > 1) {
      sendKanban('kanban.task.chain', {
        boardId: board.id,
        taskIds: chainMembers,
        enforceDependencies: enforceChainDependencies,
      });
    }
    setChangeReason('');
  };

  const managedStageOrder = ['backlog', 'todo', 'running', 'review', 'done'] as const;
  const currentManagedStage = task?.lifecycle?.currentStage;
  const managedStageIndex = currentManagedStage
    ? managedStageOrder.indexOf(currentManagedStage)
    : -1;
  const nextManagedStage =
    managedStageIndex >= 0 && managedStageIndex < managedStageOrder.length - 1
      ? managedStageOrder[managedStageIndex + 1]
      : undefined;

  const advanceManagedTask = () => {
    if (!board || !task || !nextManagedStage || !transitionComment.trim()) return;
    sendKanban('kanban.task.transition', {
      boardId: board.id,
      taskId: task.id,
      to: nextManagedStage,
      actor: agentId.trim() || name.trim() || task.assignee || task.assignedAgent || 'webui-agent',
      comment: transitionComment.trim(),
      ...(transitionAction.trim() ? { action: transitionAction.trim() } : {}),
      ...(transitionAttachmentUrl.trim()
        ? {
            attachment: {
              url: transitionAttachmentUrl.trim(),
              type: 'url',
              title: `Evidence for ${task.title}`,
            },
          }
        : {}),
    });
  };

  const addCheck = () => {
    if (!board || !task || !newCheck.trim()) return;
    sendKanban('kanban.task.check.add', {
      boardId: board.id,
      taskId: task.id,
      description: newCheck.trim(),
      checkType: 'manual',
    });
    setNewCheck('');
  };

  const recordActivity = () => {
    if (!board || !task || !newNote.trim()) return;
    sendKanban('kanban.task.activity.add', {
      boardId: board.id,
      taskId: task.id,
      kind: newActivityKind,
      outcome: newActivityOutcome,
      summary: newNote.trim(),
      ...(newActivityDetails.trim() ? { details: newActivityDetails.trim() } : {}),
      actor: name.trim() || agentId.trim() || 'webui-operator',
    });
    setNewNote('');
    setNewActivityDetails('');
    window.setTimeout(refreshActivity, 150);
  };

  const assign = () => {
    if (!board || !task) return;
    sendKanban('kanban.task.assign', payload('assign'));
    setChangeReason('');
  };

  const dispatch = () => {
    if (!board || !task) return;
    sendKanban('kanban.task.dispatch', payload('dispatch'));
    setChangeReason('');
  };

  const copyTask = () => {
    if (!board || !task || !targetBoardId) return;
    sendKanban('kanban.task.copy', { boardId: board.id, taskId: task.id, targetBoardId });
  };

  const transferTask = () => {
    if (!board || !task || !targetBoardId) return;
    sendKanban('kanban.task.transfer', { boardId: board.id, taskId: task.id, targetBoardId });
  };

  // The inspector is contextual UI, not a permanent empty sidebar. Keep all
  // hooks above unconditional, then render nothing until the user selects a task.
  if (!task) return null;

  return (
    <aside
      aria-label={t('activity:kanban.taskInspector')}
      data-expanded={expanded ? 'true' : 'false'}
      className={cn(
        'flex max-h-[42dvh] w-full shrink-0 flex-col border-t bg-card/40 transition-[width] duration-200 ease-out md:max-h-none md:border-l md:border-t-0',
        expanded
          ? 'fixed inset-0 z-50 h-dvh max-h-none w-screen border-0 bg-card transition-none md:w-screen md:border-0'
          : 'md:w-[420px] xl:w-[480px]',
      )}
    >
      <div className={cn('flex h-12 items-center gap-2 border-b px-3', expanded && 'px-5')}>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{t('activity:kanban.task')}</div>
          <div className="truncate text-[11px] text-muted-foreground">{task.id.slice(0, 8)}</div>
        </div>
        <button
          type="button"
          title={expanded ? t('activity:kanban.collapseDetails') : t('activity:kanban.expandDetails')}
          aria-label={expanded ? t('activity:kanban.collapseDetails') : t('activity:kanban.expandDetails')}
          aria-pressed={expanded}
          onClick={() => setExpanded((value) => !value)}
          className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          {expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </button>
        <button
          type="button"
          title={t('common:action.close')}
          onClick={() => {
            setExpanded(false);
            onClose();
          }}
          className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X size={16} />
        </button>
      </div>
      {task ? (
        <div
          ref={inspectorScrollRef}
          className={cn(
            'min-h-0 flex-1 overflow-y-auto overscroll-contain p-3',
            expanded && 'px-5 py-4 xl:px-7',
          )}
        >
          <div className="space-y-3 rounded-md border bg-background p-2.5">
            <KanbanBoundaryEditor
              title={t('activity:kanban.taskBoundary')}
              value={task.boundary}
              inherited={board?.boundary}
              onSave={(boundary) => {
                if (!board) return;
                sendKanban('kanban.task.update', {
                  boardId: board.id,
                  taskId: task.id,
                  boundary,
                  activityNote: 'Task boundary edited in WebUI.',
                });
              }}
            />
            <Field label={t('activity:kanban.title')} value={title} onChange={setTitle} />
            <label className="block">
              <span className="mb-1 block text-[11px] font-medium text-muted-foreground">
                {t('activity:kanbanInspector.descriptionWorkingContext')}
              </span>
              <textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                rows={5}
                className="w-full resize-y rounded-md border bg-background px-2 py-1.5 text-xs leading-5 outline-none focus:border-primary"
              />
            </label>
            <div className="grid grid-cols-2 gap-2">
              {board?.lifecycle?.mode === 'managed' ? (
                <div className="rounded-md border bg-muted/30 px-2 py-1.5">
                  <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    {t('activity:kanban.managedStage')}
                  </div>
                  <div className="mt-1 text-xs font-semibold capitalize">
                    {task.lifecycle?.currentStage ?? 'Backlog'}
                  </div>
                </div>
              ) : (
                <SelectField
                  label={t('activity:kanban.status')}
                  value={status}
                  options={[
                    'pending',
                    'ready',
                    'in_progress',
                    'blocked',
                    'review',
                    'completed',
                    'failed',
                    'archived',
                  ]}
                  onChange={(value) => setStatus(value as KanbanTask['status'])}
                />
              )}
              <SelectField
                label={t('activity:kanban.priority')}
                value={priority}
                options={['critical', 'high', 'medium', 'low']}
                onChange={(value) => setPriority(value as KanbanTask['priority'])}
              />
              <SelectField
                label={t('activity:kanban.type')}
                value={taskType}
                options={['feature', 'bugfix', 'refactor', 'docs', 'test', 'chore']}
                onChange={(value) => setTaskType(value as NonNullable<KanbanTask['type']>)}
              />
              <Field label={t('activity:kanban.labelsCommaSeparated')} value={labelsText} onChange={setLabelsText} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Field label={t('activity:kanban.dueDatePlaceholder')} value={dueDate} onChange={setDueDate} />
              <Field label={t('activity:kanban.estimatedHours')} value={estimatedHours} onChange={setEstimatedHours} />
              <Field label={t('activity:kanban.actualHours')} value={actualHours} onChange={setActualHours} />
            </div>
            <div>
              <span className="mb-1 block text-[11px] font-medium text-muted-foreground">
                {t('activity:kanbanInspector.dependencies')}
              </span>
              <ChipMultiSelect
                options={(board?.tasks ?? [])
                  .filter((candidate) => candidate.id !== task.id)
                  .map((candidate) => ({
                    value: candidate.id,
                    label: candidate.title,
                    description: candidate.status,
                  }))}
                selected={dependsOn}
                onChange={setDependsOn}
                placeholder={t('activity:kanban.selectBlockingTasks')}
              />
            </div>
            <div>
              <span className="mb-1 block text-[11px] font-medium text-muted-foreground">
                {t('activity:kanbanInspector.taskChainSelectionOrder')}
              </span>
              <ChipMultiSelect
                options={(board?.tasks ?? []).map((candidate) => ({
                  value: candidate.id,
                  label: candidate.title,
                  description: candidate.status,
                }))}
                selected={chainMembers}
                onChange={(next) =>
                  setChainMembers(next.includes(task.id) ? next : [task.id, ...next])
                }
                placeholder={t('activity:kanban.selectSequentialChain')}
              />
              <label className="mt-1.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                <input
                  type="checkbox"
                  checked={enforceChainDependencies}
                  onChange={(event) => setEnforceChainDependencies(event.target.checked)}
                />
                {t('activity:kanban.enforceChainOrder')}
              </label>
            </div>
            <Field
              label={t('activity:kanban.assignmentReason')}
              value={changeReason}
              onChange={setChangeReason}
            />
            <button
              type="button"
              onClick={saveDetails}
              className="inline-flex h-9 w-full items-center justify-center gap-2 rounded-md bg-primary text-sm text-primary-foreground hover:bg-primary/90"
            >
              <Save size={15} /> {t('activity:kanbanInspector.saveTaskContract')}
            </button>
            {board?.lifecycle?.mode === 'managed' && nextManagedStage && (
              <section
                aria-label={t('activity:kanban.managedLifecycle')}
                className="space-y-2 rounded-md border border-primary/30 bg-primary/5 p-2.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-primary">
                      {t('activity:kanban.kanbanAgentTransition')}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {currentManagedStage} → {nextManagedStage}; no stages can be skipped.
                    </div>
                  </div>
                  <ShieldCheck size={16} className="text-primary" />
                </div>
                <Field
                  label={t('activity:kanban.completedAction')}
                  value={transitionAction}
                  onChange={setTransitionAction}
                />
                <Field
                  label={t('activity:kanban.progressComment')}
                  value={transitionComment}
                  onChange={setTransitionComment}
                />
                <Field
                  label={t('activity:kanban.evidenceUrl')}
                  value={transitionAttachmentUrl}
                  onChange={setTransitionAttachmentUrl}
                />
                <button
                  type="button"
                  disabled={!transitionComment.trim()}
                  onClick={advanceManagedTask}
                  className="inline-flex h-9 w-full items-center justify-center gap-2 rounded-md bg-primary text-sm text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <MoveRight size={15} /> Advance to {nextManagedStage}
                </button>
              </section>
            )}
          </div>

          {board && (
            <>
              <TaskIntelligencePanel
                board={board}
                task={task}
                events={activityEvents}
                presence={activityPresence}
                sessionId={activitySessionId}
                sessionProvider={sessionProvider}
                sessionModel={sessionModel}
              />
              <TaskExecutionAttempts
                task={task}
                events={activityEvents}
                sessionId={activitySessionId}
              />
              <TaskRiskPanel board={board} task={task} events={activityEvents} />
            </>
          )}
          <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
            <Metric label={t('activity:kanban.source')} value={task.origin?.system ?? 'manual'} />
            <Metric label={t('activity:kanban.taskId')} value={task.id.slice(0, 8)} />
            <Metric label={t('activity:kanban.run')} value={task.assignment?.status ?? 'unassigned'} />
            <Metric label={t('activity:kanban.column')} value={columnTitle(board, task.columnId)} />
          </div>

          {task.assignment && <AgentRunPanel assignment={task.assignment} />}

          {runLink && task.origin?.taskId && (
            <RunTaskControls
              runLink={runLink}
              runTaskId={task.origin.taskId}
              modelCandidates={modelCandidates}
              sendRaw={sendRaw}
            />
          )}

          {!runLink && (
            <>
              <div className="mt-4 space-y-3">
                <SelectField
                  label={t('activity:kanban.primaryModelSource')}
                  value={routingMode}
                  options={['session', 'fixed', 'fallback_profile']}
                  onChange={(value) => setRoutingMode(value as KanbanModelRoutingMode)}
                />
                {routingMode === 'session' && (
                  <div className="rounded-md border bg-info/5 px-2 py-1.5 text-[11px] text-muted-foreground">
                    Uses the live session model: {sessionProvider ? `${sessionProvider}/` : ''}
                    {sessionModel || 'not available'}.
                  </div>
                )}
                {routingMode === 'fixed' && (
                  <div>
                    <span className="mb-1 block text-[11px] font-medium text-muted-foreground">
                      {t('activity:kanbanInspector.fixedProviderModel')}
                    </span>
                    <ModelPicker
                      value={model || undefined}
                      provider={provider || undefined}
                      candidates={modelCandidates}
                      placeholder={t('activity:kanban.selectProviderModel')}
                      onPick={(nextModel, nextProvider) => {
                        setModel(nextModel);
                        setProvider(nextProvider);
                      }}
                    />
                  </div>
                )}
                {routingMode === 'fallback_profile' && (
                  <SelectField
                    label={t('activity:kanban.fallbackProfile')}
                    value={fallbackProfile}
                    options={Object.keys(meta.fallbackProfiles)}
                    placeholder={t('activity:kanban.selectProfile')}
                    onChange={setFallbackProfile}
                  />
                )}

                {/* Fallback models — real multi-pick from the same live catalogue. */}
                <div>
                  <span className="mb-1 block text-[11px] font-medium text-muted-foreground">
                    {t('activity:kanban.fallbackModels')}
                  </span>
                  <ChipMultiSelect
                    options={modelCandidates.map((c) => ({
                      value: `${c.provider}/${c.model}`,
                      label: c.label,
                      description: c.description,
                      tag: c.provider,
                    }))}
                    selected={fallbackModels}
                    onChange={setFallbackModels}
                    placeholder={t('activity:kanban.addFallbackModel')}
                    emptyLabel="No models — add a provider in Settings"
                  />
                </div>

                <SelectField
                  label={t('activity:kanban.role')}
                  value={role}
                  options={KNOWN_ROLES}
                  placeholder={t('activity:kanban.selectRole')}
                  onChange={setRole}
                />

                <div>
                  <span className="mb-1 block text-[11px] font-medium text-muted-foreground">
                    Agentic skills{' '}
                    <span className="text-muted-foreground/70">{t('activity:kanbanInspector.forceLoadedIntoTheWorker')}</span>
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
                    placeholder={t('activity:kanban.assignSkills')}
                    emptyLabel="No skills registered"
                  />
                </div>

                {/* Tools — real registered tools from the running agent. */}
                <div>
                  <span className="mb-1 block text-[11px] font-medium text-muted-foreground">
                    Tools{' '}
                    <span className="text-muted-foreground/70">{t('activity:kanbanInspector.blankFullDefaultToolset')}</span>
                  </span>
                  <ChipMultiSelect
                    options={meta.tools.map((tool) => ({
                      value: tool.name,
                      label: tool.name,
                      description: tool.description,
                    }))}
                    selected={tools}
                    onChange={setTools}
                    placeholder={t('activity:kanban.restrictTools')}
                    emptyLabel="Tool list unavailable on this server"
                  />
                </div>

                {/* Advanced — optional name override + capability grants. */}
                <div className="rounded-md border bg-background/60">
                  <button
                    type="button"
                    onClick={() => setShowAdvanced((v) => !v)}
                    className="flex w-full items-center justify-between px-2 py-1.5 text-[11px] font-medium text-muted-foreground hover:text-foreground"
                  >
                    {t('activity:kanbanInspector.advanced')}
                    <ChevronDown
                      size={13}
                      className={cn('transition-transform', showAdvanced && 'rotate-180')}
                    />
                  </button>
                  {showAdvanced && (
                    <div className="space-y-3 border-t p-2">
                      <Field label={t('activity:kanban.agentNameOptional')} value={name} onChange={setName} />
                      <div className="grid grid-cols-2 gap-2">
                        <SelectField
                          label={t('activity:kanban.retryPolicy')}
                          value={retryPolicy}
                          options={['off', 'incremental', 'exponential']}
                          onChange={(value) =>
                            setRetryPolicy(value as NonNullable<KanbanTask['retryPolicy']>)
                          }
                        />
                        <Field label={t('activity:kanban.maxAttempts')} value={maxAttempts} onChange={setMaxAttempts} />
                        <Field
                          label={t('activity:kanban.costCeilingUsd')}
                          value={costCeilingUsd}
                          onChange={setCostCeilingUsd}
                        />
                      </div>
                      <div>
                        <span className="mb-1 block text-[11px] font-medium text-muted-foreground">
                          Capabilities{' '}
                          <span className="text-muted-foreground/70">{t('activity:kanbanInspector.blankSafeDefaults')}</span>
                        </span>
                        <ChipMultiSelect
                          options={KNOWN_CAPABILITIES}
                          selected={allowedCapabilities}
                          onChange={setAllowedCapabilities}
                          placeholder={t('activity:kanban.grantCapability')}
                        />
                      </div>
                    </div>
                  )}
                </div>
              </div>

              <div className="mt-4 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={assign}
                  className="inline-flex h-9 items-center justify-center gap-2 rounded-md border text-sm hover:bg-muted"
                >
                  <UserPlus size={15} />
                  {t('activity:kanbanInspector.assign')}
                </button>
                <button
                  type="button"
                  onClick={dispatch}
                  className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-primary text-sm text-primary-foreground hover:bg-primary/90"
                >
                  <Send size={15} />
                  {t('activity:kanbanInspector.dispatch')}
                </button>
              </div>
            </>
          )}

          {boards.length > 1 && !runLink ? (
            <div className="mt-4 space-y-2 rounded-md border bg-background p-2">
              <label className="block">
                <span className="mb-1 block text-[11px] font-medium text-muted-foreground">
                  {t('activity:kanban.targetBoard')}
                </span>
                <select
                  value={targetBoardId}
                  onChange={(event) => setTargetBoardId(event.target.value)}
                  className="h-8 w-full rounded-md border bg-background px-2 text-sm outline-none focus:border-primary"
                >
                  {boards
                    .filter((candidate) => candidate.id !== board?.id)
                    .map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>
                        {candidate.title}
                      </option>
                    ))}
                </select>
              </label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={copyTask}
                  disabled={!targetBoardId}
                  className="inline-flex h-9 items-center justify-center gap-2 rounded-md border text-sm hover:bg-muted disabled:opacity-50"
                >
                  <Copy size={15} />
                  {t('activity:kanbanInspector.copy')}
                </button>
                <button
                  type="button"
                  onClick={transferTask}
                  disabled={!targetBoardId}
                  className="inline-flex h-9 items-center justify-center gap-2 rounded-md border text-sm hover:bg-muted disabled:opacity-50"
                >
                  <MoveRight size={15} />
                  {t('activity:kanbanInspector.transfer')}
                </button>
              </div>
            </div>
          ) : null}

          <KanbanTaskCompletionChecks
            board={board}
            task={task}
            newCheck={newCheck}
            onNewCheckChange={setNewCheck}
            onAddCheck={addCheck}
            sendKanban={sendKanban}
          />
          {/*
            The contract graph and executable evidence share one verification surface.
          */}
          {board && <TaskVerificationSection board={board} task={task} sendKanban={sendKanban} />}

          {board && (
            <KanbanDecompositionPanel
              board={board}
              task={task}
              sendKanban={sendKanban}
              onSelectTask={onSelectTask}
            />
          )}

          <TaskActivityTimeline
            task={task}
            events={activityEvents}
            sessionId={activitySessionId}
            loading={activityLoading}
            error={activityError}
            onRefresh={refreshActivity}
          />

          <KanbanTaskActivityRecorder
            activityKind={newActivityKind}
            activityOutcome={newActivityOutcome}
            note={newNote}
            details={newActivityDetails}
            onActivityKindChange={setNewActivityKind}
            onActivityOutcomeChange={setNewActivityOutcome}
            onNoteChange={setNewNote}
            onDetailsChange={setNewActivityDetails}
            onRecordActivity={recordActivity}
          />
        </div>
      ) : null}
    </aside>
  );
}
