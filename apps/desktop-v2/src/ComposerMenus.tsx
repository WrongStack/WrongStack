import {
  BookOpen,
  Clock3,
  Ellipsis,
  FilePlus2,
  Gauge,
  RefreshCw,
  Repeat,
  SlidersHorizontal,
  Sparkles,
  Split,
  Terminal,
  Wand2,
} from 'lucide-react';
import type { MouseEvent, ReactNode } from 'react';
import { AgentModeControl } from './AgentModeControl';
import { AutonomyControl, autonomyControlInputs } from './AutonomyControl';
import { ComposerAccessChip } from './ComposerAccessChip';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand } from './engine-operations';
import type { EngineState } from './engine-state';
import { SessionPermissionsOption } from './SessionPermissionsOption';
import { useDetailsDismiss } from './useDetailsDismiss';

/**
 * The session settings popover: every value that shapes the next turn beyond the model. The
 * model's own settings (effort, reasoning, identity, ACP) are drawn into `slot` by
 * SessionModelControls; the run settings follow under their own heading.
 */
export function ComposerSettingsMenu({
  state,
  command,
  summary,
  slot,
  refineBeforeSend,
  preferenceBusy,
  onRefineBeforeSend,
}: {
  state: EngineState;
  command: EngineCommand;
  /** The current effort, shown on the trigger; empty when the model has none. */
  summary: string;
  slot: (element: HTMLDivElement | null) => void;
  refineBeforeSend: boolean;
  preferenceBusy: boolean;
  onRefineBeforeSend: (value: boolean) => void;
}) {
  const { t } = useDesktopText();
  const dismiss = useDetailsDismiss();
  const prefs = state.results['prefs.updated'];
  // What the closed popover must still show: turns that continue on their own. The YOLO level
  // has its own chip beside it.
  const autonomy = String(prefs?.['autonomy'] ?? '');
  const continues = ['auto', 'eternal', 'eternal-parallel'].includes(autonomy);
  return (
    <>
      <details className="composer-settings" ref={dismiss}>
        <summary aria-label={t('composer.settings.label')} title={t('composer.settings.label')}>
          <SlidersHorizontal size={14} />
          {summary && <span className="composer-settings-summary">{summary}</span>}
          {continues && (
            <Repeat
              size={12}
              className="composer-settings-flag"
              role="img"
              aria-label={t('composer.settings.continuation')}
            />
          )}
        </summary>
        <div className="composer-settings-panel">
          <p className="composer-settings-heading">{t('composer.settings.model')}</p>
          <div className="composer-settings-slot" ref={slot} />
          <p className="composer-settings-heading">{t('composer.settings.run')}</p>
          <AutonomyControl
            {...autonomyControlInputs(state.results)}
            command={command}
            disabled={!state.connected || state.needsSetup}
          />
          <AgentModeControl
            command={command}
            announced={String(state.results['session.start']?.['mode'] ?? '')}
            disabled={!state.connected || state.running}
          />
          <label className="composer-chip effort-control composer-setting-toggle">
            <Wand2 size={12} />
            <span className="composer-setting-name">{t('composer.refineBeforeSend')}</span>
            <input
              type="checkbox"
              checked={refineBeforeSend}
              disabled={preferenceBusy || !state.connected}
              onChange={(e) => onRefineBeforeSend(e.target.checked)}
            />
          </label>
          {preferenceBusy && <small role="status">{t('composer.savingPreference')}</small>}
        </div>
      </details>
      <ComposerAccessChip
        prefs={prefs}
        command={command}
        disabled={!state.connected || state.needsSetup}
      />
    </>
  );
}

/** What the composer's "more" menu can do; a missing handler leaves its item out. */
interface ComposerOptionActions {
  agentPlan: { disabled: boolean; run: () => void };
  refineDraft: { disabled: boolean; run: () => void };
  journal: () => void;
  library: () => void;
  mcpContent: { disabled: boolean; run: () => void };
  addFile: { disabled: boolean; run: () => void };
  skillMention: { disabled: boolean; run: () => void };
  context: { disabled: boolean; run: () => void };
  commands: () => void;
  refreshQueue: { disabled: boolean; run: () => void };
}

/** The composer's "more" menu: actions on the draft and the conversation, in three groups. */
export function ComposerOptionsMenu({
  state,
  command,
  actions,
}: {
  state: EngineState;
  command: EngineCommand;
  actions: ComposerOptionActions;
}) {
  const { t } = useDesktopText();
  const dismiss = useDetailsDismiss();
  /** A menu item closes the menu before it acts, as a menu does. */
  const item = (
    icon: ReactNode,
    label: string,
    run: () => void,
    disabled = false,
    keepOpen = false,
  ) => (
    <button
      type="button"
      disabled={disabled}
      onClick={(event: MouseEvent<HTMLButtonElement>) => {
        if (!keepOpen) event.currentTarget.closest('details')?.removeAttribute('open');
        run();
      }}
    >
      {icon} {label}
    </button>
  );
  return (
    <details className="composer-options" ref={dismiss}>
      <summary title={t('composer.options')} aria-label={t('composer.options')}>
        <Ellipsis size={16} />
      </summary>
      <div>
        {item(
          <Split size={14} />,
          t('composer.agentPlan'),
          actions.agentPlan.run,
          actions.agentPlan.disabled,
        )}
        <SessionPermissionsOption state={state} command={command} />
        {item(
          <Sparkles size={14} />,
          t('composer.refineDraft'),
          actions.refineDraft.run,
          actions.refineDraft.disabled,
        )}
        <hr />
        {item(<Clock3 size={14} />, t('composer.journal'), actions.journal)}
        {item(<BookOpen size={14} />, t('composer.library'), actions.library)}
        {item(
          <FilePlus2 size={14} />,
          t('composer.mcpContent'),
          actions.mcpContent.run,
          actions.mcpContent.disabled,
        )}
        {item(
          <FilePlus2 size={14} />,
          t('composer.addFile'),
          actions.addFile.run,
          actions.addFile.disabled,
        )}
        {item(
          <Sparkles size={14} />,
          t('composer.skillMention'),
          actions.skillMention.run,
          actions.skillMention.disabled,
        )}
        <hr />
        {item(
          <Gauge size={14} />,
          t('composer.contextPanel'),
          actions.context.run,
          actions.context.disabled,
        )}
        {item(<Terminal size={14} />, t('composer.commands'), actions.commands)}
        {item(
          <RefreshCw size={14} />,
          t('composer.refreshQueue'),
          actions.refreshQueue.run,
          actions.refreshQueue.disabled,
          true,
        )}
        <small>{t('composer.keys')}</small>
      </div>
    </details>
  );
}
