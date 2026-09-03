import { expectDefined, toErrorMessage } from '@wrongstack/core/utils';
import type React from 'react';
import type { AppViewProps } from './app-view-contract.js';
import { AuditPanel } from './components/audit-panel.js';
import { AuthPanel } from './components/auth-panel.js';
import { AutonomyPicker } from './components/autonomy-picker.js';
import { BrainDecisionPrompt } from './components/brain-decision-prompt.js';
import { BrainPanel } from './components/brain-panel.js';
import { CheckpointTimeline } from './components/checkpoint-timeline.js';
import { ClearConfirmPanel } from './components/clear-confirm-panel.js';
import { type ConfirmDecision, ConfirmPrompt } from './components/confirm-prompt.js';
import { ConnectionsPanel } from './components/connections-panel.js';
import { ContinueConfirmPanel } from './components/continue-confirm-panel.js';
import { CoordinatorPanel } from './components/coordinator-panel.js';
import { DesignPicker } from './components/design-picker.js';
import { EnhancePanel, RefiningPanel } from './components/enhance-panel.js';
import { EscConfirmPrompt } from './components/esc-confirm-prompt.js';
import { ExitConfirmPanel } from './components/exit-confirm-panel.js';
import { FKeyPicker } from './components/f-key-picker.js';
import { FallbackOverlay } from './components/fallback-overlay.js';
import { FilePicker } from './components/file-picker.js';
import { HelpPanel } from './components/help-panel.js';
import { McpPicker } from './components/mcp-picker.js';
import { ModePicker } from './components/mode-picker.js';
import { ModelPicker } from './components/model-picker.js';
import { PluginPicker } from './components/plugin-picker.js';
import { ProjectPicker } from './components/project-picker.js';
import { filterPromptPicker, PromptPicker } from './components/prompt-picker.js';
import { RefineCountdownPanel } from './components/refine-countdown-panel.js';
import { RefineFailurePanel } from './components/refine-failure-panel.js';
import { ResourceMenu } from './components/resource-menu.js';
import { ResumePicker } from './components/resume-picker.js';
import { SendModePicker } from './components/send-mode-picker.js';
import { SettingsPicker } from './components/settings-picker.js';
import { ShadowPanel } from './components/shadow-panel.js';
import {
  ShellCommandWarning,
  type ShellCommandWarningDecision,
} from './components/shell-command-warning.js';
import { SkillPicker } from './components/skill-picker.js';
import { SlashConfirmPanel } from './components/slash-confirm-panel.js';
import { SlashMenu } from './components/slash-menu.js';
import { StatuslinePicker } from './components/statusline-picker.js';
import { ThemePicker } from './components/theme-picker.js';
import { ToolsPicker } from './components/tools-picker.js';
import { TopicCheckPanel } from './components/topic-check-panel.js';
import { Box } from './ink.js';
import { getActiveThemeName, THEME_OPTIONS } from './theme.js';
import type { PanelId, SendMode } from './ui-contracts.js';

const CONTINUE_CONFIRM_DELAY_MS = 4000;

interface AppViewPickersProps {
  host: AppViewProps['host'];
  runtime: AppViewProps['runtime'];
  mainColumnWidth: number;
  pickerMaxRows: number;
  routedToSidebar: (id: PanelId) => boolean;
  panelPositions: Record<PanelId, 'bottom' | 'sidebar'>;
}

export function AppViewPickers({
  host,
  runtime,
  mainColumnWidth,
  pickerMaxRows,
  routedToSidebar,
  panelPositions,
}: AppViewPickersProps): React.ReactElement {
  const { agent, events, getSettings, onYolo, profileConfigPath, saveSettings } = host;
  const {
    state,
    dispatch,
    activity,
    environment,
    viewState,
    handleRewindTo,
    activeCtrlRef,
    clearPendingConfirms,
    liveDirector,
    dismissedEscAtRef,
    enhanceOriginalRef,
    enhanceStartedAt,
    enhanceDurationMs,
    refineProviderId,
    refineModel,
    setEnhanceCountdown,
    enhanceDelayMs,
    statusBarClickMapRef,
  } = runtime;
  const { nowTick, enhanceDots } = activity;
  const { setYoloLive } = environment;
  const { inputHeight } = viewState;

  return (
    <>
      {state.picker.open ? (
        <FilePicker
          query={state.picker.query}
          matches={state.picker.matches}
          selected={state.picker.selected}
        />
      ) : null}
      {state.slashPicker.open ? (
        <SlashMenu
          query={state.slashPicker.query}
          matches={state.slashPicker.matches}
          selected={state.slashPicker.selected}
        />
      ) : null}
      {state.modelPicker.open ? (
        <ModelPicker
          step={state.modelPicker.step}
          providerOptions={state.modelPicker.providerOptions}
          modelOptions={state.modelPicker.modelOptions}
          filteredOptions={state.modelPicker.filteredOptions}
          selected={state.modelPicker.selected}
          pickedProviderId={state.modelPicker.pickedProviderId}
          searchQuery={state.modelPicker.searchQuery}
          hint={state.modelPicker.hint}
          titleLabel={state.modelPicker.title}
          columns={mainColumnWidth}
          maxRows={pickerMaxRows}
        />
      ) : null}
      {state.autonomyPicker.open ? (
        <AutonomyPicker
          options={state.autonomyPicker.options}
          selected={state.autonomyPicker.selected}
          hint={state.autonomyPicker.hint}
        />
      ) : null}
      {state.modePicker.open ? (
        <ModePicker
          modes={state.modePicker.modes}
          selected={state.modePicker.selected}
          hint={state.modePicker.hint}
        />
      ) : null}
      {state.themePicker.open ? (
        <ThemePicker
          options={THEME_OPTIONS}
          selected={state.themePicker.selected}
          activeId={getActiveThemeName()}
          hint={state.themePicker.hint}
          columns={mainColumnWidth}
          maxRows={pickerMaxRows}
        />
      ) : null}
      {state.skillPicker.open ? (
        <SkillPicker
          entries={state.skillPicker.entries}
          selected={state.skillPicker.selected}
          hint={state.skillPicker.hint}
          columns={mainColumnWidth}
          maxRows={pickerMaxRows}
        />
      ) : null}
      {state.resourceMenu.open && state.resourceMenu.snapshot ? (
        <ResourceMenu
          snapshot={state.resourceMenu.snapshot}
          selected={state.resourceMenu.selected}
          hint={state.resourceMenu.hint}
          confirming={state.resourceMenu.pendingAction?.label}
          filter={state.resourceMenu.filter}
          filtering={state.resourceMenu.filtering}
          columns={mainColumnWidth}
          maxRows={pickerMaxRows}
        />
      ) : null}
      {state.designPicker.open ? (
        <DesignPicker
          kits={state.designPicker.kits}
          selected={state.designPicker.selected}
          stack={state.designPicker.stack}
        />
      ) : null}
      {state.promptPicker.open ? (
        <PromptPicker
          entries={filterPromptPicker(
            state.promptPicker.all,
            state.promptPicker.categories,
            state.promptPicker.catIndex,
            state.promptPicker.recentSlugs,
          )}
          selected={state.promptPicker.selected}
          category={state.promptPicker.categories[state.promptPicker.catIndex] ?? 'all'}
          total={state.promptPicker.all.length}
          columns={mainColumnWidth}
          maxRows={pickerMaxRows}
        />
      ) : null}
      {state.resumePicker.open ? (
        <ResumePicker
          sessions={state.resumePicker.sessions}
          selected={state.resumePicker.selected}
          busy={state.resumePicker.busy}
          error={state.resumePicker.error}
          hint={state.resumePicker.hint}
        />
      ) : null}
      {state.settingsPicker.open ? (
        <SettingsPicker
          field={state.settingsPicker.field}
          mode={state.settingsPicker.mode}
          delayMs={state.settingsPicker.delayMs}
          titleAnimation={state.settingsPicker.titleAnimation}
          yolo={state.settingsPicker.yolo}
          fleetChat={state.settingsPicker.fleetChat}
          chime={state.settingsPicker.chime}
          confirmExit={state.settingsPicker.confirmExit}
          nextPrediction={state.settingsPicker.nextPrediction}
          featureMcp={state.settingsPicker.featureMcp}
          featurePlugins={state.settingsPicker.featurePlugins}
          featureMemory={state.settingsPicker.featureMemory}
          featureSkills={state.settingsPicker.featureSkills}
          featureModelsRegistry={state.settingsPicker.featureModelsRegistry}
          tokenSavingTier={state.settingsPicker.tokenSavingTier}
          allowOutsideProjectRoot={state.settingsPicker.allowOutsideProjectRoot}
          contextAutoCompact={state.settingsPicker.contextAutoCompact}
          contextStrategy={state.settingsPicker.contextStrategy}
          contextMode={state.settingsPicker.contextMode}
          maxConcurrent={state.settingsPicker.maxConcurrent}
          logLevel={state.settingsPicker.logLevel}
          auditLevel={state.settingsPicker.auditLevel}
          indexOnStart={state.settingsPicker.indexOnStart}
          multiDiffSummaryThreshold={state.settingsPicker.multiDiffSummaryThreshold}
          thinkingWord={state.settingsPicker.thinkingWord}
          thinkingWordEditing={state.settingsPicker.thinkingWordEditing}
          thinkingWordDraft={state.settingsPicker.thinkingWordDraft}
          maxIterations={state.settingsPicker.maxIterations}
          autoProceedMaxIterations={state.settingsPicker.autoProceedMaxIterations}
          enhanceDelayMs={state.settingsPicker.enhanceDelayMs}
          preRefineSeconds={state.settingsPicker.preRefineSeconds}
          enhanceEnabled={state.settingsPicker.enhanceEnabled}
          enhanceLanguage={state.settingsPicker.enhanceLanguage}
          debugStream={state.settingsPicker.debugStream}
          statuslineMode={state.settingsPicker.statuslineMode}
          reasoningMode={state.settingsPicker.reasoningMode}
          reasoningEffort={state.settingsPicker.reasoningEffort}
          reasoningEffortLevels={state.settingsPicker.reasoningEffortLevels}
          reasoningPreserve={state.settingsPicker.reasoningPreserve}
          cacheTtl={state.settingsPicker.cacheTtl}
          configScope={state.settingsPicker.configScope}
          profileConfigPath={profileConfigPath}
          animationStyle={state.settingsPicker.animationStyle}
          breakerEnabled={state.settingsPicker.breakerEnabled}
          breakerAutoKillResetMs={state.settingsPicker.breakerAutoKillResetMs}
          showModelReasoning={state.settingsPicker.showModelReasoning}
          showAgentSwarmPanel={state.settingsPicker.showAgentSwarmPanel}
          showSidebar={state.settingsPicker.showSidebar}
          showSageMemoryInject={state.settingsPicker.showSageMemoryInject}
          sageMemoryInjectThreshold={state.settingsPicker.sageMemoryInjectThreshold}
          nextStepsTool={state.settingsPicker.nextStepsTool}
          readSymbols={state.settingsPicker.readSymbols}
          panelPositions={state.settingsPicker.panelPositions}
          // WrongProxy / WrongTrace (fields 59–60): the runtime probe
          // reads both keys from the same SettingsPicker slice (see
          // `runtime-controller-deps.ts:applyLiveSettings`). Wiring them
          // here closes the round-trip from the picker to the live Config
          // + ctx.meta. Without these props, `pnpm typecheck` fails and
          // the runtime probe never sees the picker's mid-session toggle.
          wrongProxyEnabled={state.settingsPicker.wrongProxyEnabled}
          wrongProxyUrl={state.settingsPicker.wrongProxyUrl}
          wrongProxyUrlEditing={state.settingsPicker.wrongProxyUrlEditing}
          wrongProxyUrlDraft={state.settingsPicker.wrongProxyUrlDraft}
          inputHeight={inputHeight}
          filter={state.settingsPicker.filter}
          hint={state.settingsPicker.hint}
        />
      ) : null}
      {state.statuslinePicker.open ? (
        <StatuslinePicker
          field={state.statuslinePicker.field}
          hiddenItems={state.statuslinePicker.hiddenItems}
          lines={state.statuslinePicker.lines}
          densities={state.statuslinePicker.densities}
          visibleChips={state.statuslinePicker.visibleChips}
          filter={state.statuslinePicker.filter}
          filtering={state.statuslinePicker.filtering}
          hint={state.statuslinePicker.hint}
          // Real geometry from the bar's last render — the fill gauges are
          // measured, not estimated.
          clickMap={statusBarClickMapRef.current}
        />
      ) : null}
      {state.pluginPicker.open ? (
        <PluginPicker
          items={state.pluginPicker.items}
          selected={state.pluginPicker.selected}
          busy={state.pluginPicker.busy}
          hint={state.pluginPicker.hint}
        />
      ) : null}
      {state.mcpPicker.open ? (
        <McpPicker
          items={state.mcpPicker.items}
          selected={state.mcpPicker.selected}
          busy={state.mcpPicker.busy}
          hint={state.mcpPicker.hint}
        />
      ) : null}
      {state.toolsPicker.open ? (
        <ToolsPicker
          items={state.toolsPicker.items}
          selected={state.toolsPicker.selected}
          busy={state.toolsPicker.busy}
          hint={state.toolsPicker.hint}
          filter={state.toolsPicker.filter}
        />
      ) : null}
      {state.brainPanel.open && !state.modelPicker.open ? (
        <BrainPanel {...state.brainPanel} />
      ) : null}
      {state.helpPanel.open ? (
        <HelpPanel
          entries={state.helpPanel.entries}
          filter={state.helpPanel.filter}
          selected={state.helpPanel.selected}
          hint={state.helpPanel.hint}
        />
      ) : null}
      {state.shadowPanel.open ? (
        <ShadowPanel shadow={state.shadowPanel.shadow} hint={state.shadowPanel.hint} />
      ) : null}
      {state.authPanel.open ? <AuthPanel panel={state.authPanel} /> : null}
      {state.projectPicker.open && !routedToSidebar('projectPicker') ? (
        <ProjectPicker
          items={state.projectPicker.items}
          selected={state.projectPicker.selected}
          filter={state.projectPicker.filter}
          hint={state.projectPicker.hint}
        />
      ) : null}
      {state.fKeyPicker.open ? <FKeyPicker selected={state.fKeyPicker.selected} /> : null}
      {state.coordinator.monitorOpen && !routedToSidebar('coordinator') ? (
        <CoordinatorPanel
          coordinator={state.coordinator}
          nowTick={nowTick}
          onClose={() => dispatch({ type: 'toggleCoordinatorMonitor' })}
        />
      ) : null}
      {state.auditPanelOpen ? (
        <AuditPanel
          sideEffects={agent.ctx.sideEffects ?? []}
          onClose={() => dispatch({ type: 'toggleAuditPanel' })}
        />
      ) : null}
      {state.connectionsPanelOpen && panelPositions.connections === 'bottom' ? (
        <ConnectionsPanel
          projectRoot={agent.ctx.projectRoot}
          onClose={() => dispatch({ type: 'toggleConnectionsPanel' })}
        />
      ) : null}
      {state.rewindOverlay
        ? (() => {
            const overlay = state.rewindOverlay;
            return (
              <CheckpointTimeline
                checkpoints={overlay.checkpoints}
                selected={overlay.selected}
                onSelect={(i) =>
                  dispatch({ type: 'rewindOverlayMove', delta: i - overlay.selected })
                }
                onConfirm={(i) => {
                  const checkpoint = overlay.checkpoints[i];
                  if (checkpoint) {
                    void handleRewindTo(checkpoint.promptIndex).catch((err: unknown) => {
                      dispatch({
                        type: 'addEntry',
                        entry: {
                          kind: 'error',
                          text: `Rewind failed: ${toErrorMessage(err)}`,
                        },
                      });
                    });
                  }
                }}
                onClose={() => dispatch({ type: 'rewindOverlayClose' })}
              />
            );
          })()
        : null}
      {state.brainPrompt ? (
        <Box flexDirection="column" marginY={1} flexShrink={0}>
          <BrainDecisionPrompt
            {...state.brainPrompt}
            onAnswer={(answer) => {
              events.emit('brain.human_answered', { ...answer, at: Date.now() });
              dispatch({ type: 'brainPromptClear' });
            }}
          />
        </Box>
      ) : null}
      {state.shellCommandWarning
        ? (() => {
            const info = state.shellCommandWarning;
            let resolved = false;
            const onDecision = (decision: ShellCommandWarningDecision) => {
              if (resolved) return;
              resolved = true;
              info.resolve(decision);
              dispatch({ type: 'shellCommandWarningClose' });
            };
            return <ShellCommandWarning command={info.command} onDecision={onDecision} />;
          })()
        : null}
      {state.confirmQueue.length > 0 &&
        (() => {
          const head = expectDefined(state.confirmQueue[0]);
          let resolved = false;
          const onDecision = (decision: ConfirmDecision) => {
            if (resolved) return;
            resolved = true;
            head.resolve(decision);
            dispatch({ type: 'confirmClose' });
          };
          const onEnableYolo = () => {
            if (resolved) return;
            onYolo?.(true);
            setYoloLive(true);
            const cur = getSettings?.();
            if (cur && saveSettings) {
              Promise.resolve(saveSettings({ ...cur, yolo: true })).catch(() => {});
            }
            resolved = true;
            head.resolve('yes');
            dispatch({ type: 'confirmClose' });
          };
          return (
            <ConfirmPrompt
              toolName={head.toolName}
              input={head.input}
              suggestedPattern={head.suggestedPattern}
              onDecision={onDecision}
              onEnableYolo={onEnableYolo}
              destructive={head.destructive}
              boundaryReason={head.boundaryReason}
              writeTargets={head.writeTargets}
            />
          );
        })()}
      {state.clearConfirm ? (
        <ClearConfirmPanel
          leaderActive={state.clearConfirm.leaderActive}
          subagentCount={state.clearConfirm.subagentCount}
          value={state.clearConfirm.value}
        />
      ) : null}
      {state.exitConfirm ? (
        <ExitConfirmPanel
          leaderActive={state.exitConfirm.leaderActive}
          subagentCount={state.exitConfirm.subagentCount}
          backgroundCount={state.exitConfirm.backgroundCount}
        />
      ) : null}
      {state.slashConfirm ? (
        <SlashConfirmPanel
          question={state.slashConfirm.question}
          defaultYes={state.slashConfirm.defaultYes}
        />
      ) : null}
      {state.escConfirm ? (
        <Box flexDirection="column" marginY={1} flexShrink={0}>
          <EscConfirmPrompt
            runningTools={state.escConfirm.snapshot.runningTools}
            subagentCount={state.escConfirm.snapshot.subagentsTerminated}
            onConfirm={() => {
              const escConfirm = state.escConfirm;
              if (!escConfirm) return;
              const { snapshot } = escConfirm;
              activeCtrlRef.current?.abort('user interrupt (Esc)');
              clearPendingConfirms();
              dispatch({ type: 'status', status: 'aborting' });
              dispatch({ type: 'steerStart', snapshot });
              const escConfirmDir = liveDirector();
              if (escConfirmDir && snapshot.subagentsTerminated > 0) {
                const cap = new Promise<void>((resolve) => {
                  const t = setTimeout(resolve, 1500);
                  t.unref?.();
                });
                void Promise.race([escConfirmDir.terminateAll().catch(() => undefined), cap]);
              }
              const droppedCount = state.queue.length;
              if (droppedCount > 0) dispatch({ type: 'queueClear' });
              const droppedTag = droppedCount > 0 ? ` · dropped ${droppedCount} queued` : '';
              const fleetTag =
                snapshot.subagentsTerminated > 0
                  ? ` · stopped ${snapshot.subagentsTerminated} subagent${snapshot.subagentsTerminated === 1 ? '' : 's'}`
                  : '';
              dispatch({
                type: 'addEntry',
                entry: {
                  kind: 'warn',
                  text: `↯ Interrupted${droppedTag}${fleetTag}. Type your new direction.`,
                },
              });
              dispatch({ type: 'escConfirmClose' });
            }}
            onCancel={() => {
              dismissedEscAtRef.current = Date.now();
              dispatch({ type: 'escConfirmClose' });
            }}
          />
        </Box>
      ) : null}
      {state.fallbackOverlay ? (
        <Box flexDirection="column" marginY={1} flexShrink={0}>
          {(() => {
            const ov = state.fallbackOverlay;
            let resolved = false;
            const finish = (choice: { providerId: string; model: string } | null) => {
              if (resolved) return;
              resolved = true;
              if (choice) {
                events.emit('provider.fallback_choice', {
                  requestId: ov.requestId,
                  providerId: choice.providerId,
                  model: choice.model,
                });
              } else {
                events.emit('provider.fallback_choice', {
                  requestId: ov.requestId,
                  autoSwitch: true,
                });
              }
              dispatch({ type: 'fallbackOverlayClose' });
            };
            return (
              <FallbackOverlay
                requestId={ov.requestId}
                from={ov.from}
                status={ov.status}
                candidates={ov.candidates}
                autoSwitchSeconds={ov.autoSwitchSeconds}
                selected={ov.selected}
                onChoose={finish}
                onMove={(delta) => dispatch({ type: 'fallbackOverlayMove', delta })}
              />
            );
          })()}
        </Box>
      ) : null}
      {state.sendModePicker
        ? (() => {
            const info = state.sendModePicker;
            let resolved = false;
            const finish = (decision: SendMode | 'cancel') => {
              if (resolved) return;
              resolved = true;
              info.resolve(decision);
            };
            return (
              <SendModePicker
                selected={info.selected}
                messagePreview={info.displayText}
                onMove={(delta) => dispatch({ type: 'sendModePickerMove', delta })}
                onSelect={finish}
              />
            );
          })()
        : null}
      {state.refineCountdown
        ? (() => {
            const info = state.refineCountdown;
            let resolved = false;
            const onDecision = (decision: Parameters<typeof info.resolve>[0]) => {
              if (resolved) return;
              resolved = true;
              info.resolve(decision);
            };
            return (
              <RefineCountdownPanel
                key={`refine-countdown-${state.refineCountdownGen}`}
                original={info.original}
                seconds={info.seconds}
                onDecision={onDecision}
                providerId={
                  refineProviderId ?? (agent.ctx.provider as { id?: string } | undefined)?.id
                }
                model={refineModel ?? agent.ctx.model}
              />
            );
          })()
        : null}
      {state.enhanceBusy && !state.enhance ? (
        <RefiningPanel
          original={enhanceOriginalRef.current}
          elapsedMs={enhanceStartedAt === null ? 0 : Math.max(0, Date.now() - enhanceStartedAt)}
          pulseFrame={enhanceDots}
          providerId={refineProviderId ?? (agent.ctx.provider as { id?: string } | undefined)?.id}
          model={refineModel ?? agent.ctx.model}
        />
      ) : null}
      {state.topicCheckBusy ? <TopicCheckPanel prompt={state.buffer} /> : null}
      {state.enhance
        ? (() => {
            const info = state.enhance;
            let resolved = false;
            const onDecision = (decision: Parameters<typeof info.resolve>[0]) => {
              if (resolved) return;
              resolved = true;
              setEnhanceCountdown(null);
              info.resolve(decision);
            };
            return (
              <EnhancePanel
                original={info.original}
                refined={info.refined}
                english={info.english}
                durationMs={enhanceDurationMs ?? 0}
                delayMs={enhanceDelayMs}
                enhanceLanguage={state.settingsPicker.enhanceLanguage}
                onDecision={onDecision}
                onTick={(r) => setEnhanceCountdown(r > 0 ? r : null)}
                providerId={
                  refineProviderId ?? (agent.ctx.provider as { id?: string } | undefined)?.id
                }
                model={refineModel ?? agent.ctx.model}
              />
            );
          })()
        : null}
      {state.refineFailure
        ? (() => {
            const info = state.refineFailure;
            let resolved = false;
            const onDecision = (decision: Parameters<typeof info.resolve>[0]) => {
              if (resolved) return;
              resolved = true;
              info.resolve(decision);
            };
            return (
              <RefineFailurePanel
                original={info.original}
                error={info.error}
                elapsedMs={info.elapsedMs}
                fallbackRef={info.fallbackRef}
                models={info.models}
                onDecision={onDecision}
              />
            );
          })()
        : null}
      {state.continueConfirm
        ? (() => {
            const info = state.continueConfirm;
            let resolved = false;
            const onDecision = (decision: 'proceed' | 'edit' | 'cancel') => {
              if (resolved) return;
              resolved = true;
              info.resolve(decision);
            };
            return (
              <ContinueConfirmPanel
                label={info.label}
                instruction={info.instruction}
                source={info.source}
                grounded={info.grounded}
                delayMs={CONTINUE_CONFIRM_DELAY_MS}
                onDecision={onDecision}
              />
            );
          })()
        : null}
    </>
  );
}
