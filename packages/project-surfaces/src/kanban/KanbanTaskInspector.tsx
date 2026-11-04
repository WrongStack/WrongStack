import type {
  KanbanBoard,
  KanbanBoardPresence,
  KanbanEvent,
  KanbanManualActivityKind,
  KanbanManualActivityOutcome,
  KanbanModelRoutingMode,
  KanbanTask,
} from '@wrongstack/kanban';
import { Maximize2, Minimize2, Save, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useSurfaceHost } from '../host';
import { useAppTranslation } from '../lib/i18n';
import { cn } from '../lib/utils';
import { useModelCandidates as useProviderModels } from './feed';
import { KanbanBoundaryEditor } from './KanbanBoundaryEditor';
import { KanbanDecompositionPanel } from './KanbanDecompositionPanel';
import type { RunLink } from './KanbanRunControls';
import { KanbanTaskActivityRecorder } from './KanbanTaskActivityRecorder';
import { KanbanTaskCompletionChecks } from './KanbanTaskCompletionChecks';
import { KanbanTaskContractFields } from './KanbanTaskContractFields';
import { KanbanTaskExecution } from './KanbanTaskExecution';
import { columnTitle, Field, Metric } from './KanbanTaskFields';
import {
  blockingTaskTitles,
  type TaskInspectorTab,
  TaskInspectorTabBar,
  TaskStatusSpine,
  TaskTabLayout,
  taskTabBadges,
} from './KanbanTaskInspectorChrome';
import { kanbanMetadataText } from './kanban-metadata';
import { TaskActivityTimeline } from './TaskActivityTimeline';
import { TaskRiskPanel } from './TaskRiskPanel';
import { TaskVerificationSection } from './TaskVerificationSection';
import { useKanbanMeta } from './useKanbanMeta';

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
  const surfaceHost = useSurfaceHost();
  const TaskExtras = surfaceHost.kanban?.TaskExtras;
  const inspectorScrollRef = surfaceHost.useScrollRestore<HTMLDivElement>(
    'kanban-task-inspector',
    Boolean(task),
  );
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [activeTab, setActiveTab] = useState<TaskInspectorTab>('definition');
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
        action:
          action === 'dispatch' ? t('activity:kanban.dispatched') : t('activity:kanban.assigned'),
        target:
          name.trim() || agentId.trim() || role.trim() || t('activity:kanban.configuredAgentRoute'),
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

  const asideRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!task) return undefined;
    const previous = document.activeElement as HTMLElement | null;
    asideRef.current?.focus();
    return () => {
      // Esc/close returns focus to whatever opened the inspector.
      previous?.focus?.();
    };
  }, [task?.id]);
  const handleInspectorKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape') return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
    event.stopPropagation();
    onClose();
  };
  // The inspector is contextual UI, not a permanent empty sidebar. Keep all
  // hooks above unconditional, then render nothing until the user selects a task.
  if (!task) return null;

  const blockedBy = blockingTaskTitles(board, task);
  const taskEventCount = activityEvents.filter((event) => event.taskId === task.id).length;

  return (
    <aside
      ref={asideRef}
      tabIndex={-1}
      onKeyDown={handleInspectorKeyDown}
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
          title={
            expanded ? t('activity:kanban.collapseDetails') : t('activity:kanban.expandDetails')
          }
          aria-label={
            expanded ? t('activity:kanban.collapseDetails') : t('activity:kanban.expandDetails')
          }
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
      <TaskStatusSpine
        task={task}
        blockedBy={blockedBy}
        columnLabel={columnTitle(board, task.columnId)}
        expanded={expanded}
        blockedLabel={t('activity:kanbanInspector.waitingOn')}
        regionLabel={t('activity:kanbanInspector.taskStatusSummary')}
      />
      <TaskInspectorTabBar
        active={activeTab}
        onSelect={setActiveTab}
        badges={taskTabBadges(board, task, taskEventCount)}
        labelFor={(labelKey) => t(labelKey)}
        expanded={expanded}
      />
      {task ? (
        <div
          ref={inspectorScrollRef}
          className={cn(
            'min-h-0 flex-1 overflow-y-auto overscroll-contain p-3',
            expanded && 'px-5 py-4 xl:px-7',
          )}
        >
          <TaskTabLayout
            expanded={expanded}
            rail={
              activeTab === 'definition' ? (
                <div className="grid grid-cols-2 gap-2 text-xs xl:grid-cols-1">
                  <Metric
                    label={t('activity:kanban.source')}
                    value={task.origin?.system ?? 'manual'}
                  />
                  <Metric label={t('activity:kanban.taskId')} value={task.id.slice(0, 8)} />
                  <Metric
                    label={t('activity:kanban.run')}
                    value={task.assignment?.status ?? 'unassigned'}
                  />
                  <Metric
                    label={t('activity:kanban.column')}
                    value={columnTitle(board, task.columnId)}
                  />
                </div>
              ) : activeTab === 'execution' && board ? (
                <TaskRiskPanel board={board} task={task} events={activityEvents} />
              ) : undefined
            }
          >
            {activeTab === 'definition' && (
              <>
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
                  <KanbanTaskContractFields
                    board={board}
                    task={task}
                    status={status}
                    setStatus={setStatus}
                    priority={priority}
                    setPriority={setPriority}
                    taskType={taskType}
                    setTaskType={setTaskType}
                    labelsText={labelsText}
                    setLabelsText={setLabelsText}
                    dueDate={dueDate}
                    setDueDate={setDueDate}
                    estimatedHours={estimatedHours}
                    setEstimatedHours={setEstimatedHours}
                    actualHours={actualHours}
                    setActualHours={setActualHours}
                    dependsOn={dependsOn}
                    setDependsOn={setDependsOn}
                    chainMembers={chainMembers}
                    setChainMembers={setChainMembers}
                    enforceChainDependencies={enforceChainDependencies}
                    setEnforceChainDependencies={setEnforceChainDependencies}
                  />
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
                </div>
                {/* Expanded moves these to the rail; docked keeps them inline so the
              numbers never disappear entirely. */}
                {!expanded && (
                  <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                    <Metric
                      label={t('activity:kanban.source')}
                      value={task.origin?.system ?? 'manual'}
                    />
                    <Metric label={t('activity:kanban.taskId')} value={task.id.slice(0, 8)} />
                    <Metric
                      label={t('activity:kanban.run')}
                      value={task.assignment?.status ?? 'unassigned'}
                    />
                    <Metric
                      label={t('activity:kanban.column')}
                      value={columnTitle(board, task.columnId)}
                    />
                  </div>
                )}
              </>
            )}

            {/* Advancing a managed card is an act of running it, so it lives
              with execution rather than with the contract that defines it. */}
            <KanbanTaskExecution
              activeTab={activeTab}
              board={board}
              nextManagedStage={nextManagedStage}
              t={t}
              currentManagedStage={currentManagedStage}
              transitionAction={transitionAction}
              setTransitionAction={setTransitionAction}
              transitionComment={transitionComment}
              setTransitionComment={setTransitionComment}
              transitionAttachmentUrl={transitionAttachmentUrl}
              setTransitionAttachmentUrl={setTransitionAttachmentUrl}
              advanceManagedTask={advanceManagedTask}
              task={task}
              activityEvents={activityEvents}
              activityPresence={activityPresence}
              activitySessionId={activitySessionId}
              sessionProvider={sessionProvider}
              sessionModel={sessionModel}
              runLink={runLink}
              modelCandidates={modelCandidates}
              sendRaw={sendRaw}
              routingMode={routingMode}
              setRoutingMode={setRoutingMode}
              model={model}
              provider={provider}
              setModel={setModel}
              setProvider={setProvider}
              fallbackProfile={fallbackProfile}
              meta={meta}
              setFallbackProfile={setFallbackProfile}
              fallbackModels={fallbackModels}
              setFallbackModels={setFallbackModels}
              role={role}
              setRole={setRole}
              skills={skills}
              setSkills={setSkills}
              tools={tools}
              setTools={setTools}
              setShowAdvanced={setShowAdvanced}
              showAdvanced={showAdvanced}
              name={name}
              setName={setName}
              retryPolicy={retryPolicy}
              setRetryPolicy={setRetryPolicy}
              maxAttempts={maxAttempts}
              setMaxAttempts={setMaxAttempts}
              costCeilingUsd={costCeilingUsd}
              setCostCeilingUsd={setCostCeilingUsd}
              allowedCapabilities={allowedCapabilities}
              setAllowedCapabilities={setAllowedCapabilities}
              assign={assign}
              dispatch={dispatch}
              boards={boards}
              targetBoardId={targetBoardId}
              setTargetBoardId={setTargetBoardId}
              copyTask={copyTask}
              transferTask={transferTask}
            />

            {activeTab === 'evidence' && (
              <>
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
                {board && (
                  <TaskVerificationSection board={board} task={task} sendKanban={sendKanban} />
                )}
              </>
            )}

            {activeTab === 'breakdown' && board && (
              <>
                <KanbanDecompositionPanel
                  board={board}
                  task={task}
                  sendKanban={sendKanban}
                  onSelectTask={onSelectTask}
                />
                {TaskExtras && <TaskExtras board={board} task={task} />}
              </>
            )}

            {activeTab === 'history' && (
              <>
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
              </>
            )}
          </TaskTabLayout>
        </div>
      ) : null}
    </aside>
  );
}
