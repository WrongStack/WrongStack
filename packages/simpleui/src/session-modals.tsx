import type { ComponentProps } from 'react';
import { BrainPanel } from './brain-panel.js';
import { CommandPalette } from './command-palette.js';
import { ContextBreakdownModal } from './context-breakdown-modal.js';
import { ErrorBoundary } from './error-boundary.js';
import { FallbackModal, type FallbackPendingProjection } from './fallback-modal.js';
import { FileDiffPanel } from './file-diff-panel.js';
import { FileExplorer } from './file-explorer.js';
import type { CommandPaletteAction } from './lib/command-palette-model.js';
import type { OutageKind } from './lib/server-health.js';
import type { SimpleSocket } from './lib/ws.js';
import { MemoryDrawer } from './memory-drawer.js';
import { PromptLibrary } from './prompt-library.js';
import { VectorMemoryPanel } from './vector-memory-panel.js';
import { ServerOutageOverlay } from './server-outage-overlay.js';
import { SessionHealthPanel } from './session-health-panel.js';
import { SettingsPanel } from './settings-panel.js';
import type {
  ChatMessage,
  ContextInfo,
  FileEditMeta,
  SessionInfo,
} from './types.js';

export interface SessionModalsProps {
  socketRef: { current: SimpleSocket | null };
  session: SessionInfo | null;
  running: boolean;
  leaderSelected: boolean;
  commandPaletteOpen: boolean;
  onCloseCommandPalette: () => void;
  onRunCommandPaletteAction: (action: CommandPaletteAction) => void;
  onRecallPrompt: (text: string) => void;
  context: ContextInfo;
  messages: ChatMessage[];
  sessionStart: number | null;
  contextBreakdownOpen: boolean;
  onCloseContextBreakdown: () => void;
  onOpenContextBreakdown: () => void;
  onCompactContext: () => void;
  fallbackPending: FallbackPendingProjection | null;
  onCloseFallbackModal: () => void;
  settingsOpen: boolean;
  onCloseSettings: () => void;
  prefs: ComponentProps<typeof SettingsPanel>['prefs'];
  modes: ComponentProps<typeof SettingsPanel>['modes'];
  activeModeId: string;
  palette: ComponentProps<typeof SettingsPanel>['palette'];
  connection: ComponentProps<typeof SettingsPanel>['connection'];
  onAutonomyChange: ComponentProps<typeof SettingsPanel>['onAutonomyChange'];
  onModeChange: ComponentProps<typeof SettingsPanel>['onModeChange'];
  onPaletteChange: ComponentProps<typeof SettingsPanel>['onPaletteChange'];
  onPrefChange: ComponentProps<typeof SettingsPanel>['onPrefChange'];
  onResetPrefs: ComponentProps<typeof SettingsPanel>['onReset'];
  isAtDefaults: boolean;
  diffFiles: FileEditMeta[] | null;
  onCloseDiffFiles: () => void;
  outageDismissed: boolean;
  outage: OutageKind;
  onDismissOutage: () => void;
  sessionId: string | null;
}

export function SessionModals(props: SessionModalsProps) {
  const {
    socketRef,
    session,
    running,
    leaderSelected,
    commandPaletteOpen,
    onCloseCommandPalette,
    onRunCommandPaletteAction,
    onRecallPrompt,
    context,
    messages,
    sessionStart,
    contextBreakdownOpen,
    onCloseContextBreakdown,
    onOpenContextBreakdown,
    onCompactContext,
    fallbackPending,
    onCloseFallbackModal,
    settingsOpen,
    onCloseSettings,
    prefs,
    modes,
    activeModeId,
    palette,
    connection,
    onAutonomyChange,
    onModeChange,
    onPaletteChange,
    onPrefChange,
    onResetPrefs,
    isAtDefaults,
    diffFiles,
    onCloseDiffFiles,
    outageDismissed,
    outage,
    onDismissOutage,
    sessionId,
  } = props;

  return (
    <>
      <CommandPalette
        open={commandPaletteOpen}
        context={{
          hasSession: Boolean(session),
          running,
          canCompose: leaderSelected,
          canCompact: Boolean(session) && !running,
        }}
        onClose={onCloseCommandPalette}
        onRun={onRunCommandPaletteAction}
      />

      <MemoryDrawer socketRef={socketRef} />
      <FileExplorer socketRef={socketRef} />
      <PromptLibrary onRecall={onRecallPrompt} />
      <BrainPanel socketRef={socketRef} />
      <VectorMemoryPanel />
      <SessionHealthPanel
        context={context}
        messages={messages}
        sessionStart={sessionStart}
        onOpenContextBreakdown={onOpenContextBreakdown}
      />

      <ErrorBoundary>
        <ContextBreakdownModal
          open={contextBreakdownOpen}
          onClose={onCloseContextBreakdown}
          socketRef={socketRef}
          context={context}
          sessionId={sessionId}
          sessionStart={sessionStart}
          running={running}
          onCompact={onCompactContext}
        />
      </ErrorBoundary>

      <ErrorBoundary>
        <FallbackModal
          info={fallbackPending}
          socketRef={socketRef}
          onClose={onCloseFallbackModal}
        />
      </ErrorBoundary>

      <ErrorBoundary>
        <SettingsPanel
          open={settingsOpen}
          prefs={prefs}
          modes={modes}
          activeModeId={activeModeId}
          palette={palette}
          connection={connection}
          onClose={onCloseSettings}
          onAutonomyChange={onAutonomyChange}
          onModeChange={onModeChange}
          onPaletteChange={onPaletteChange}
          onPrefChange={onPrefChange}
          onReset={onResetPrefs}
          isAtDefaults={isAtDefaults}
          subagentPolicyLocked={messages.some((message) => message.role === 'user')}
        />
      </ErrorBoundary>

      {diffFiles && (
        <FileDiffPanel files={diffFiles} socketRef={socketRef} onClose={onCloseDiffFiles} />
      )}

      {!outageDismissed && <ServerOutageOverlay outage={outage} onDismiss={onDismissOutage} />}
    </>
  );
}
