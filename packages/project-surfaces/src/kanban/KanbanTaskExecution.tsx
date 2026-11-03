import type { KanbanModelRoutingMode, KanbanTask } from '@wrongstack/kanban';
import type { TFunction } from 'i18next';

import { ChevronDown, Copy, MoveRight, Send, ShieldCheck, UserPlus } from 'lucide-react';

import { cn } from '../lib/utils';

import { ChipMultiSelect } from '../ui/ChipMultiSelect';
import { ModelPicker } from '../ui/ModelPicker';
import { AgentRunPanel } from './KanbanAgentRunPanel';
import { RunTaskControls } from './KanbanRunControls';
import { Field, SelectField } from './KanbanTaskFields';
import { KNOWN_CAPABILITIES, KNOWN_ROLES } from './KanbanTaskOptions';

import { TaskExecutionAttempts } from './TaskExecutionAttempts';

import { TaskIntelligencePanel } from './TaskIntelligencePanel';

export function KanbanTaskExecution({
  activeTab,
  board,
  nextManagedStage,
  t,
  currentManagedStage,
  transitionAction,
  setTransitionAction,
  transitionComment,
  setTransitionComment,
  transitionAttachmentUrl,
  setTransitionAttachmentUrl,
  advanceManagedTask,
  task,
  activityEvents,
  activityPresence,
  activitySessionId,
  sessionProvider,
  sessionModel,
  runLink,
  modelCandidates,
  sendRaw,
  routingMode,
  setRoutingMode,
  model,
  provider,
  setModel,
  setProvider,
  fallbackProfile,
  meta,
  setFallbackProfile,
  fallbackModels,
  setFallbackModels,
  role,
  setRole,
  skills,
  setSkills,
  tools,
  setTools,
  setShowAdvanced,
  showAdvanced,
  name,
  setName,
  retryPolicy,
  setRetryPolicy,
  maxAttempts,
  setMaxAttempts,
  costCeilingUsd,
  setCostCeilingUsd,
  allowedCapabilities,
  setAllowedCapabilities,
  assign,
  dispatch,
  boards,
  targetBoardId,
  setTargetBoardId,
  copyTask,
  transferTask,
}: {
  activeTab: import('./KanbanTaskInspectorChrome').TaskInspectorTab;
  board: import('../../../kanban/dist/types.js').KanbanBoard | null;
  nextManagedStage: 'backlog' | 'todo' | 'running' | 'review' | 'done' | undefined;
  t: TFunction<'translation', undefined>;
  currentManagedStage: import('../../../kanban/dist/types.js').KanbanLifecycleStage | undefined;
  transitionAction: string;
  setTransitionAction: React.Dispatch<React.SetStateAction<string>>;
  transitionComment: string;
  setTransitionComment: React.Dispatch<React.SetStateAction<string>>;
  transitionAttachmentUrl: string;
  setTransitionAttachmentUrl: React.Dispatch<React.SetStateAction<string>>;
  advanceManagedTask: () => void;
  task: import('../../../kanban/dist/types.js').KanbanTask;
  activityEvents: import('../../../kanban/dist/types.js').KanbanEvent[];
  activityPresence: import('../../../kanban/dist/types.js').KanbanBoardPresence[] | undefined;
  activitySessionId: string | undefined;
  sessionProvider: string | undefined;
  sessionModel: string | undefined;
  runLink: import('./KanbanRunControls').RunLink | null;
  modelCandidates: import('./kanban-host').ModelCandidate[];
  sendRaw: (type: string, payload?: Record<string, unknown> | undefined) => void;
  routingMode: import('../../../kanban/dist/supervision-types.js').KanbanModelRoutingMode;
  setRoutingMode: React.Dispatch<
    React.SetStateAction<import('../../../kanban/dist/supervision-types.js').KanbanModelRoutingMode>
  >;
  model: string;
  provider: string;
  setModel: React.Dispatch<React.SetStateAction<string>>;
  setProvider: React.Dispatch<React.SetStateAction<string>>;
  fallbackProfile: string;
  meta: ReturnType<typeof import('./useKanbanMeta').useKanbanMeta>;
  setFallbackProfile: React.Dispatch<React.SetStateAction<string>>;
  fallbackModels: string[];
  setFallbackModels: React.Dispatch<React.SetStateAction<string[]>>;
  role: string;
  setRole: React.Dispatch<React.SetStateAction<string>>;
  skills: string[];
  setSkills: React.Dispatch<React.SetStateAction<string[]>>;
  tools: string[];
  setTools: React.Dispatch<React.SetStateAction<string[]>>;
  setShowAdvanced: React.Dispatch<React.SetStateAction<boolean>>;
  showAdvanced: boolean;
  name: string;
  setName: React.Dispatch<React.SetStateAction<string>>;
  retryPolicy: NonNullable<
    import('../../../kanban/dist/task-policy-types.js').KanbanRetryPolicy | undefined
  >;
  setRetryPolicy: React.Dispatch<
    React.SetStateAction<
      NonNullable<import('../../../kanban/dist/task-policy-types.js').KanbanRetryPolicy | undefined>
    >
  >;
  maxAttempts: string;
  setMaxAttempts: React.Dispatch<React.SetStateAction<string>>;
  costCeilingUsd: string;
  setCostCeilingUsd: React.Dispatch<React.SetStateAction<string>>;
  allowedCapabilities: string[];
  setAllowedCapabilities: React.Dispatch<React.SetStateAction<string[]>>;
  assign: () => void;
  dispatch: () => void;
  boards: { id: string; title: string }[];
  targetBoardId: string;
  setTargetBoardId: React.Dispatch<React.SetStateAction<string>>;
  copyTask: () => void;
  transferTask: () => void;
}) {
  return (
    activeTab === 'execution' && (
      <>
        {board?.lifecycle?.mode === 'managed' && nextManagedStage && (
          <section
            aria-label={t('activity:kanban.managedLifecycle')}
            className="space-y-2 rounded-md border border-primary/30 bg-primary/5 p-2.5"
          >
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wide text-foreground">
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

        {/* Who and what is running this card right now — provider,
                    model, agent. Current-run facts, not history. */}
        {board && (
          <TaskIntelligencePanel
            board={board}
            task={task}
            events={activityEvents}
            presence={activityPresence}
            sessionId={activitySessionId}
            sessionProvider={sessionProvider}
            sessionModel={sessionModel}
          />
        )}

        {board && (
          <TaskExecutionAttempts
            task={task}
            events={activityEvents}
            sessionId={activitySessionId}
          />
        )}

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
                  <span className="text-muted-foreground/70">
                    {t('activity:kanbanInspector.forceLoadedIntoTheWorker')}
                  </span>
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
                  <span className="text-muted-foreground/70">
                    {t('activity:kanbanInspector.blankFullDefaultToolset')}
                  </span>
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
                    <Field
                      label={t('activity:kanban.agentNameOptional')}
                      value={name}
                      onChange={setName}
                    />
                    <div className="grid grid-cols-2 gap-2">
                      <SelectField
                        label={t('activity:kanban.retryPolicy')}
                        value={retryPolicy}
                        options={['off', 'incremental', 'exponential']}
                        onChange={(value) =>
                          setRetryPolicy(value as NonNullable<KanbanTask['retryPolicy']>)
                        }
                      />
                      <Field
                        label={t('activity:kanban.maxAttempts')}
                        value={maxAttempts}
                        onChange={setMaxAttempts}
                      />
                      <Field
                        label={t('activity:kanban.costCeilingUsd')}
                        value={costCeilingUsd}
                        onChange={setCostCeilingUsd}
                      />
                    </div>
                    <div>
                      <span className="mb-1 block text-[11px] font-medium text-muted-foreground">
                        Capabilities{' '}
                        <span className="text-muted-foreground/70">
                          {t('activity:kanbanInspector.blankSafeDefaults')}
                        </span>
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
      </>
    )
  );
}
