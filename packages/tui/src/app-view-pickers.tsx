import type React from 'react';
import { type AppViewPickersProps, AppViewPrompts } from './app-view-prompts.js';
import { AuditPanel } from './components/audit-panel.js';
import { AuthPanel } from './components/auth-panel.js';
import { AutonomyPicker } from './components/autonomy-picker.js';
import { BrainPanel } from './components/brain-panel.js';
import { ConnectionsPanel } from './components/connections-panel.js';
import { CoordinatorPanel } from './components/coordinator-panel.js';
import { DesignPicker } from './components/design-picker.js';
import { FKeyPicker } from './components/f-key-picker.js';
import { FilePicker } from './components/file-picker.js';
import { HelpPanel } from './components/help-panel.js';
import { McpPicker } from './components/mcp-picker.js';
import { MemoryPanel } from './components/memory-panel.js';
import { ModePicker } from './components/mode-picker.js';
import { ModelPicker } from './components/model-picker.js';
import { effortOptionsForFocused } from './components/model-picker-effort.js';
import { PanelInputProvider } from './components/monitor-shell.js';
import { PluginPicker } from './components/plugin-picker.js';
import { ProjectPicker } from './components/project-picker.js';
import { filterPromptPicker, PromptPicker } from './components/prompt-picker.js';
import { ResourceMenu } from './components/resource-menu.js';
import { ResumePicker } from './components/resume-picker.js';
import { SettingsPicker } from './components/settings-picker.js';
import { ShadowPanel } from './components/shadow-panel.js';
import { SkillPicker } from './components/skill-picker.js';
import { SlashMenu } from './components/slash-menu.js';
import { StatuslinePicker } from './components/statusline-picker.js';
import { SubagentModelsPanel } from './components/subagent-models-panel.js';
import { ThemePicker } from './components/theme-picker.js';
import { ToolsPicker } from './components/tools-picker.js';
import { Box } from './ink.js';
import { getActiveThemeName, THEME_OPTIONS } from './theme.js';

export function AppViewPickers({
  host,
  runtime,
  mainColumnWidth,
  pickerMaxRows,
  pickerInputEnabled = true,
  routedToSidebar,
  panelPositions,
}: AppViewPickersProps): React.ReactElement {
  const { agent, profileConfigPath } = host;
  const { state, dispatch, activity, viewState, statusBarClickMapRef } = runtime;
  const { nowTick } = activity;
  const { inputHeight } = viewState;

  return (
    <>
      <Box flexDirection="column" display={pickerInputEnabled ? 'flex' : 'none'}>
        {state.picker.open ? (
          <FilePicker
            columns={mainColumnWidth}
            query={state.picker.query}
            matches={state.picker.matches}
            selected={state.picker.selected}
            maxRows={pickerMaxRows}
          />
        ) : null}
        {state.slashPicker.open ? (
          <SlashMenu
            columns={mainColumnWidth}
            query={state.slashPicker.query}
            matches={state.slashPicker.matches}
            selected={state.slashPicker.selected}
            maxRows={pickerMaxRows}
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
            effortOptions={effortOptionsForFocused(state.modelPicker)}
            effortChoice={state.modelPicker.effort}
          />
        ) : null}
        {state.autonomyPicker.open ? (
          <AutonomyPicker
            options={state.autonomyPicker.options}
            selected={state.autonomyPicker.selected}
            hint={state.autonomyPicker.hint}
            maxRows={pickerMaxRows}
          />
        ) : null}
        {state.modePicker.open ? (
          <ModePicker
            maxRows={pickerMaxRows}
            columns={mainColumnWidth}
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
            filter={state.themePicker.filter}
            columns={mainColumnWidth}
            maxRows={pickerMaxRows}
          />
        ) : null}
        {state.skillPicker.open ? (
          <SkillPicker
            mention={Boolean(state.skillPicker.mention)}
            entries={state.skillPicker.entries}
            selected={state.skillPicker.selected}
            hint={state.skillPicker.hint}
            columns={mainColumnWidth}
            maxRows={pickerMaxRows}
          />
        ) : null}
        {state.resourceMenu.open && state.resourceMenu.snapshot ? (
          <PanelInputProvider value={pickerInputEnabled}>
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
          </PanelInputProvider>
        ) : null}
        {state.designPicker.open ? (
          <DesignPicker
            kits={state.designPicker.kits}
            selected={state.designPicker.selected}
            stack={state.designPicker.stack}
            maxRows={pickerMaxRows}
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
            level={state.promptPicker.level}
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
            maxRows={pickerMaxRows}
          />
        ) : null}
        {state.settingsPicker.open ? (
          <SettingsPicker
            maxRows={pickerMaxRows}
            columns={mainColumnWidth}
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
            featureToolCoach={state.settingsPicker.featureToolCoach}
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
            toolResultViewMode={state.settingsPicker.toolResultViewMode}
            selectionMode={state.settingsPicker.selectionMode}
            showAgentSwarmPanel={state.settingsPicker.showAgentSwarmPanel}
            showSidebar={state.settingsPicker.showSidebar}
            showSageMemoryInject={state.settingsPicker.showSageMemoryInject}
            sageMemoryInjectThreshold={state.settingsPicker.sageMemoryInjectThreshold}
            nextStepsTool={state.settingsPicker.nextStepsTool}
            nextStepsRequired={state.settingsPicker.nextStepsRequired}
            rememberStartupChoices={state.settingsPicker.rememberStartupChoices}
            nextSystemPromptVariant={state.settingsPicker.nextSystemPromptVariant}
            includeGlobalAgents={state.settingsPicker.includeGlobalAgents}
            includeProjectAgents={state.settingsPicker.includeProjectAgents}
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
          <PanelInputProvider value={pickerInputEnabled}>
            <StatuslinePicker
              field={state.statuslinePicker.field}
              hiddenItems={state.statuslinePicker.hiddenItems}
              lines={state.statuslinePicker.lines}
              densities={state.statuslinePicker.densities}
              order={state.statuslinePicker.order}
              visibleChips={state.statuslinePicker.visibleChips}
              filter={state.statuslinePicker.filter}
              filtering={state.statuslinePicker.filtering}
              hint={state.statuslinePicker.hint}
              // Real geometry from the bar's last render — the fill gauges are
              // measured, not estimated.
              clickMap={statusBarClickMapRef.current}
            />
          </PanelInputProvider>
        ) : null}
        {state.pluginPicker.open ? (
          <PluginPicker
            maxRows={pickerMaxRows}
            columns={mainColumnWidth}
            items={state.pluginPicker.items}
            selected={state.pluginPicker.selected}
            busy={state.pluginPicker.busy}
            hint={state.pluginPicker.hint}
          />
        ) : null}
        {state.mcpPicker.open ? (
          <McpPicker
            maxRows={pickerMaxRows}
            columns={mainColumnWidth}
            items={state.mcpPicker.items}
            selected={state.mcpPicker.selected}
            busy={state.mcpPicker.busy}
            hint={state.mcpPicker.hint}
            editor={state.mcpPicker.editor}
          />
        ) : null}
        {state.toolsPicker.open ? (
          <ToolsPicker
            maxRows={pickerMaxRows}
            columns={mainColumnWidth}
            items={state.toolsPicker.items}
            selected={state.toolsPicker.selected}
            busy={state.toolsPicker.busy}
            hint={state.toolsPicker.hint}
            filter={state.toolsPicker.filter}
          />
        ) : null}
        {state.brainPanel.open && !state.modelPicker.open ? (
          <BrainPanel {...state.brainPanel} maxRows={pickerMaxRows} columns={mainColumnWidth} />
        ) : null}
        {state.helpPanel.open ? (
          <HelpPanel
            columns={mainColumnWidth}
            entries={state.helpPanel.entries}
            filter={state.helpPanel.filter}
            selected={state.helpPanel.selected}
            hint={state.helpPanel.hint}
            maxRows={pickerMaxRows}
            detailScroll={state.helpPanel.detailScroll}
          />
        ) : null}
        {state.subagentModels.open && !state.modelPicker.open ? (
          <SubagentModelsPanel
            lanes={state.subagentModels.lanes}
            roles={state.subagentModels.roles}
            selected={state.subagentModels.selected}
            enabled={state.subagentModels.enabled}
            lock={state.subagentModels.lock}
            followSessionModel={state.subagentModels.followSessionModel}
            sessionTarget={state.subagentModels.sessionTarget}
            hint={state.subagentModels.hint}
            maxRows={pickerMaxRows}
          />
        ) : null}
        {state.shadowPanel.open ? (
          <ShadowPanel
            maxRows={pickerMaxRows}
            shadow={state.shadowPanel.shadow}
            hint={state.shadowPanel.hint}
          />
        ) : null}
        {state.memoryPanel.open ? (
          <MemoryPanel
            entries={state.memoryPanel.entries}
            selected={state.memoryPanel.selected}
            filter={state.memoryPanel.filter}
            busy={state.memoryPanel.busy}
            hint={state.memoryPanel.hint}
            maxRows={pickerMaxRows}
            columns={mainColumnWidth}
          />
        ) : null}
        {state.authPanel.open ? (
          <AuthPanel panel={state.authPanel} maxRows={pickerMaxRows} columns={mainColumnWidth} />
        ) : null}
        {state.projectPicker.open && !routedToSidebar('projectPicker') ? (
          <PanelInputProvider value={pickerInputEnabled}>
            <ProjectPicker
              items={state.projectPicker.items}
              selected={state.projectPicker.selected}
              filter={state.projectPicker.filter}
              hint={state.projectPicker.hint}
            />
          </PanelInputProvider>
        ) : null}
        {state.fKeyPicker.open ? (
          <PanelInputProvider value={pickerInputEnabled}>
            <FKeyPicker selected={state.fKeyPicker.selected} />
          </PanelInputProvider>
        ) : null}
        {state.coordinator.monitorOpen && !routedToSidebar('coordinator') ? (
          <CoordinatorPanel
            coordinator={state.coordinator}
            nowTick={nowTick}
            onClose={() => dispatch({ type: 'toggleCoordinatorMonitor' })}
          />
        ) : null}
        {state.auditPanelOpen ? (
          <PanelInputProvider value={pickerInputEnabled}>
            <AuditPanel
              maxRows={pickerMaxRows}
              sideEffects={agent.ctx.sideEffects ?? []}
              onClose={() => dispatch({ type: 'toggleAuditPanel' })}
            />
          </PanelInputProvider>
        ) : null}
        {state.connectionsPanelOpen && panelPositions.connections === 'bottom' ? (
          <ConnectionsPanel
            projectRoot={agent.ctx.projectRoot}
            maxRows={pickerMaxRows}
            onClose={() => dispatch({ type: 'toggleConnectionsPanel' })}
          />
        ) : null}
      </Box>
      <AppViewPrompts host={host} runtime={runtime} pickerMaxRows={pickerMaxRows} />
    </>
  );
}
