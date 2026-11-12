import type { SessionTreeSnapshot } from '@wrongstack/contracts/types';
import type { SessionTreeCoordinator } from '@wrongstack/core/storage';
import { expectDefined, toErrorMessage } from '@wrongstack/core/utils';
import type React from 'react';
import { useCallback, useEffect, useState } from 'react';
import type { Action } from './app-action-type.js';
import type { AppViewProps } from './app-view-contract.js';
import { BrainDecisionPrompt } from './components/brain-decision-prompt.js';
import { BugHuntContinuePanel } from './components/bug-hunt-continue-panel.js';
import { BugHuntRunningPanel } from './components/bug-hunt-running-panel.js';
import { CheckpointTimeline } from './components/checkpoint-timeline.js';
import { ClearConfirmPanel } from './components/clear-confirm-panel.js';
import { type ConfirmDecision, ConfirmPrompt } from './components/confirm-prompt.js';
import { ContinueConfirmPanel } from './components/continue-confirm-panel.js';
import { EnhancePanel, RefiningPanel } from './components/enhance-panel.js';
import { EscConfirmPrompt } from './components/esc-confirm-prompt.js';
import { ExitConfirmPanel } from './components/exit-confirm-panel.js';
import { FallbackOverlay } from './components/fallback-overlay.js';
import { replaySessionMessages } from './components/history/replay.js';
import { ImagePreviewModal } from './components/image-preview-modal.js';
import { PluginPanelOverlay } from './components/plugin-panel-overlay.js';
import { PluginPromptModal } from './components/plugin-prompt-modal.js';
import { RefineCountdownPanel } from './components/refine-countdown-panel.js';
import { RefineFailurePanel } from './components/refine-failure-panel.js';
import { SendModePicker } from './components/send-mode-picker.js';
import { SessionTreeOverlay } from './components/session-tree-overlay.js';
import {
  ShellCommandWarning,
  type ShellCommandWarningDecision,
} from './components/shell-command-warning.js';
import { SlashConfirmPanel } from './components/slash-confirm-panel.js';
import { TopicCheckPanel } from './components/topic-check-panel.js';
import { Box, Text, useInput } from './ink.js';
import { showRewind } from './rewind-prompt.js';
import { standaloneModalStoreOf, useStandaloneModal } from './standalone-modal-store.js';
import { sanitizeTerminalText } from './terminal-width.js';
import type { PanelId, SendMode } from './ui-contracts.js';

function LiveSessionTreeModal({
  coordinator,
  dispatch,
  maxRows,
  onClose,
}: {
  coordinator: SessionTreeCoordinator;
  dispatch: (action: Action) => void;
  maxRows: number;
  onClose: () => void;
}): React.ReactElement {
  const [tree, setTree] = useState<SessionTreeSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | undefined>(undefined);

  useInput((_input, key) => {
    if (!tree && key.escape) {
      onClose();
    }
  });

  const refreshTree = useCallback(async (): Promise<boolean> => {
    try {
      const next = await coordinator.getTree();
      setTree(next);
      return true;
    } catch (err) {
      setStatusMessage(`Failed to load tree: ${toErrorMessage(err)}`);
      return false;
    }
  }, [coordinator]);

  useEffect(() => {
    void refreshTree();
  }, [refreshTree]);

  if (!tree) {
    return (
      <Box borderStyle="round" borderColor="cyan" paddingX={1}>
        <Text color={statusMessage ? 'red' : 'cyan'}>
          {statusMessage ?? 'Loading session tree… (Esc to close)'}
        </Text>
      </Box>
    );
  }

  return (
    <SessionTreeOverlay
      tree={tree}
      maxRows={maxRows}
      busy={busy}
      confirmFold
      statusMessage={statusMessage}
      onSwitch={(branch, opts) => {
        setBusy(true);
        setStatusMessage(undefined);
        void coordinator
          .switchBranch(branch.id, {
            keepFiles: opts.keepFiles,
            reactivateArchived: branch.status === 'archived',
          })
          .then(async (res) => {
            const entries = replaySessionMessages(res.messages, [], 1);
            dispatch({ type: 'replaceHistory', entries, nextId: entries.length + 1 });
            const reloaded = await refreshTree();
            if (reloaded) {
              const staleCount = res.resumeValidation?.staleFiles.length ?? 0;
              const staleNote =
                staleCount > 0 ? ` · ${staleCount} stale observed file(s) — re-read` : '';
              setStatusMessage(
                `Switched to ${res.toBranch.name}${res.workspaceRestored ? ' (workspace restored)' : ''}${staleNote}.`,
              );
            }
          })
          .catch((err: unknown) => {
            setStatusMessage(`Switch failed: ${toErrorMessage(err)}`);
          })
          .finally(() => setBusy(false));
      }}
      onFold={(branch, opts) => {
        setBusy(true);
        setStatusMessage(undefined);
        void coordinator
          .foldBranch({
            sourceBranch: branch.id,
            ...(opts?.keepOpen !== undefined ? { archiveSource: !opts.keepOpen } : {}),
          })
          .then(async (res) => {
            const entries = replaySessionMessages(res.messages, [], 1);
            dispatch({ type: 'replaceHistory', entries, nextId: entries.length + 1 });
            const reloaded = await refreshTree();
            if (reloaded) {
              setStatusMessage(`Folded ${res.sourceBranch.name} → ${res.targetBranch.name}.`);
            }
          })
          .catch((err: unknown) => {
            setStatusMessage(`Fold failed: ${toErrorMessage(err)}`);
          })
          .finally(() => setBusy(false));
      }}
      onArchive={(branch) => {
        setBusy(true);
        setStatusMessage(undefined);
        void coordinator
          .archiveBranch(branch.id)
          .then(async () => {
            const reloaded = await refreshTree();
            if (reloaded) {
              setStatusMessage(`Archived branch ${branch.name}.`);
            }
          })
          .catch((err: unknown) => {
            setStatusMessage(`Archive failed: ${toErrorMessage(err)}`);
          })
          .finally(() => setBusy(false));
      }}
      onCreateBranch={(name, fromBranch) => {
        setBusy(true);
        setStatusMessage(undefined);
        void coordinator
          .createBranch({
            name,
            fromBranch: fromBranch.id,
            switchImmediately: true,
          })
          .then(async (res) => {
            if (res.messages) {
              const entries = replaySessionMessages(res.messages, [], 1);
              dispatch({ type: 'replaceHistory', entries, nextId: entries.length + 1 });
            }
            const reloaded = await refreshTree();
            if (reloaded) {
              setStatusMessage(`Created and switched to branch ${res.branch.name}.`);
            }
          })
          .catch((err: unknown) => {
            setStatusMessage(`Create branch failed: ${toErrorMessage(err)}`);
          })
          .finally(() => setBusy(false));
      }}
      onClose={onClose}
    />
  );
}

const CONTINUE_CONFIRM_DELAY_MS = 4000;

export interface AppViewPickersProps {
  host: AppViewProps['host'];
  runtime: AppViewProps['runtime'];
  mainColumnWidth: number;
  pickerMaxRows: number;
  pickerInputEnabled?: boolean | undefined;
  routedToSidebar: (id: PanelId) => boolean;
  panelPositions: Record<PanelId, 'bottom' | 'sidebar'>;
}

/**
 * The modal prompts and overlays layered under the picker column: rewind,
 * Brain and tool confirmations, exit/clear/slash/Esc confirms, fallback,
 * send-mode, refine/enhance flows, continue and bug-hunt panels.
 */
export function AppViewPrompts({
  host,
  runtime,
  pickerMaxRows,
}: Pick<AppViewPickersProps, 'host' | 'runtime' | 'pickerMaxRows'>): React.ReactElement {
  const { agent, events, getSettings, onYolo, saveSettings } = host;
  const {
    state,
    dispatch,
    activity,
    environment,
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
  } = runtime;
  const { enhanceDots } = activity;
  const { setYoloLive } = environment;
  const { modal: standaloneModal, closeModal: closeStandaloneModal } = useStandaloneModal(dispatch);

  useEffect(() => {
    const registry = host.pluginUiRegistry;
    if (!registry) return undefined;
    const modalStore = standaloneModalStoreOf(dispatch);
    registry.setHandlers({
      onNotify: (owner, message, tone) => {
        const cleanOwner = sanitizeTerminalText(owner);
        const cleanMsg = sanitizeTerminalText(message);
        const entryKind = tone === 'danger' ? 'error' : tone === 'warning' ? 'warn' : 'info';
        dispatch({
          type: 'addEntry',
          entry: {
            kind: entryKind,
            text: `[${cleanOwner}] ${cleanMsg}`,
          },
        });
      },
      onPrompt: (owner, opts, signal) =>
        new Promise((resolvePrompt) => {
          if (signal.aborted) {
            resolvePrompt(null);
            return;
          }
          let settled = false;
          const finish = (val: string | boolean | null) => {
            if (settled) return;
            settled = true;
            signal.removeEventListener('abort', onAbort);
            const cur = modalStore.get();
            if (cur?.kind === 'plugin-prompt' && cur.resolve === finish) {
              modalStore.close();
            }
            resolvePrompt(val as never);
          };
          const onAbort = () => finish(null);
          signal.addEventListener('abort', onAbort, { once: true });
          // A second prompt can arrive before the first is answered. Resolve the
          // displaced one (as cancelled) instead of replacing it silently —
          // otherwise the first plugin's promise stays pending forever.
          const previous = modalStore.get();
          if (previous?.kind === 'plugin-prompt') {
            previous.resolve(null);
          }
          modalStore.set({
            kind: 'plugin-prompt',
            owner,
            opts: opts as never,
            resolve: finish,
          });
        }),
    });
    return () => {
      const cur = modalStore.get();
      if (cur?.kind === 'plugin-prompt') {
        cur.resolve(null);
      }
      registry.setHandlers({ onNotify: undefined, onPrompt: undefined });
    };
  }, [host.pluginUiRegistry, dispatch]);

  return (
    <>
      {standaloneModal?.kind === 'tree' ? (
        (() => {
          const coordinator =
            typeof host.treeCoordinator === 'function'
              ? host.treeCoordinator()
              : host.treeCoordinator;
          if (!coordinator) return null;
          return (
            <LiveSessionTreeModal
              coordinator={coordinator}
              dispatch={dispatch}
              maxRows={pickerMaxRows}
              onClose={closeStandaloneModal}
            />
          );
        })()
      ) : standaloneModal?.kind === 'plugin-panel' && host.pluginUiRegistry ? (
        <PluginPanelOverlay
          registry={host.pluginUiRegistry}
          initialPanelId={standaloneModal.panelId}
          onClose={closeStandaloneModal}
        />
      ) : standaloneModal?.kind === 'plugin-prompt' ? (
        <PluginPromptModal
          owner={standaloneModal.owner}
          opts={standaloneModal.opts}
          onResolve={standaloneModal.resolve}
        />
      ) : standaloneModal?.kind === 'image' ? (
        <ImagePreviewModal
          filePath={standaloneModal.filePath}
          capability={host.capability}
          onClose={closeStandaloneModal}
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
                    const draft = state.buffer;
                    return handleRewindTo(checkpoint.promptIndex)
                      .then((outcome) => showRewind(dispatch, draft, outcome))
                      .catch((err: unknown) => {
                        dispatch({
                          type: 'addEntry',
                          entry: {
                            kind: 'error',
                            text: `Rewind failed: ${toErrorMessage(err)}`,
                          },
                        });
                      });
                  }
                  return undefined;
                }}
                {...(host.forkSession
                  ? {
                      onFork: (i: number) => {
                        const checkpoint = overlay.checkpoints[i];
                        if (checkpoint) {
                          dispatch({ type: 'checkpointFork', promptIndex: checkpoint.promptIndex });
                        }
                      },
                    }
                  : {})}
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
              Promise.resolve(saveSettings({ ...cur, yolo: true })).catch((err: unknown) =>
                dispatch({
                  type: 'addEntry',
                  entry: {
                    kind: 'error',
                    text: `Could not save YOLO setting: ${toErrorMessage(err)}`,
                  },
                }),
              );
            }
            // YOLO removes routine prompts, not the destructive gate that put
            // this specific call on screen. Keep it pending for y/n/a/d or Brain.
            if (head.destructive) return;
            resolved = true;
            head.resolve('yes');
            dispatch({ type: 'confirmClose' });
          };
          return (
            <ConfirmPrompt
              key={head.toolUseId}
              maxRows={pickerMaxRows}
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
      {state.bugHuntContinue
        ? (() => {
            const info = state.bugHuntContinue;
            let resolved = false;
            const onDecision = (decision: 'yes' | 'stop') => {
              if (resolved) return;
              resolved = true;
              info.resolve(decision);
            };
            return (
              <BugHuntContinuePanel
                completedRounds={info.completedRounds}
                totalRounds={info.totalRounds}
                label={info.label}
                onDecision={onDecision}
              />
            );
          })()
        : null}
      {state.bugHuntRunning ? (
        <BugHuntRunningPanel
          currentRound={state.bugHuntRunning.currentRound}
          totalRounds={state.bugHuntRunning.totalRounds}
          commandName={state.bugHuntRunning.commandName}
          label={state.bugHuntRunning.label}
        />
      ) : null}
    </>
  );
}
