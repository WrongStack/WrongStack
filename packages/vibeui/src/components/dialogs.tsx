'use client';

import { AlertCircle, Check, KeyRound, Moon, PanelTop, Settings2, Sun, X } from 'lucide-react';
import { Dialog } from 'radix-ui';
import { useEffect, useRef, useState } from 'react';
import { uiVersion } from '../lib/build-info';
import { inputQueueLabel } from '../lib/component-guards';
import type { InputRequest } from '../lib/session';
import type { SessionController } from '../lib/use-session';
import { CodePanel } from './code-panel';
import { DetailSwitch, usePresentation } from './presentation-mode';
import { RuntimeControls } from './runtime-controls';
import { SettingsSearch } from './settings-search';
import { useWorkspacePreferences } from './workspace-preferences';

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  dismissible = true,
  wide = false,
  drawer = false,
  initialFocusRef,
  icon,
  headerActions,
  detailToggle = false,
  onEscapeKeyDown,
}: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
  title: string;
  description: string;
  children: React.ReactNode;
  dismissible?: boolean;
  wide?: boolean;
  drawer?: boolean;
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  icon?: React.ReactNode;
  headerActions?: React.ReactNode;
  detailToggle?: boolean;
  onEscapeKeyDown?: (event: KeyboardEvent) => void;
}) {
  const { preferences } = useWorkspacePreferences();
  const { mode } = usePresentation();
  const opener = useRef<HTMLElement | null>(null);
  const surface = useRef<HTMLElement | null>(null);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content
          onEscapeKeyDown={onEscapeKeyDown}
          onOpenAutoFocus={(event) => {
            opener.current =
              document.activeElement instanceof HTMLElement ? document.activeElement : null;
            surface.current = event.target instanceof HTMLElement ? event.target : null;
            if (initialFocusRef?.current) {
              event.preventDefault();
              initialFocusRef.current.focus();
            }
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const active = document.activeElement;
            // Search results and newly opened dialogs retain their deliberate focus.
            if (
              active instanceof HTMLElement &&
              active !== document.body &&
              active !== document.documentElement &&
              !surface.current?.contains(active)
            )
              return;
            const target = opener.current;
            if (
              target?.isConnected &&
              target !== document.body &&
              target !== document.documentElement
            ) {
              target.focus({ preventScroll: true });
              if (document.activeElement === target) return;
            }
            document
              .querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')
              ?.focus({ preventScroll: true });
          }}
          className={`modal-content ${wide ? 'modal-wide' : ''} ${drawer ? 'modal-drawer' : ''}`}
        >
          <header className="modal-heading">
            <div className="modal-heading-content">
              <span className="modal-heading-icon" aria-hidden="true">
                {icon || <PanelTop size={20} />}
              </span>
              <div className="modal-heading-text">
                <Dialog.Title>{title}</Dialog.Title>
                <Dialog.Description className="modal-description">{description}</Dialog.Description>
                {detailToggle && (preferences.view === 'studio' || mode === 'extended') && (
                  <DetailSwitch />
                )}
              </div>
            </div>
            {(dismissible || headerActions) && (
              <div className="modal-heading-actions">
                {headerActions}
                {dismissible && (
                  <Dialog.Close
                    className="icon-button modal-close"
                    aria-label="Close dialog"
                    title="Close · Esc"
                  >
                    <X size={18} />
                  </Dialog.Close>
                )}
              </div>
            )}
          </header>
          <div className="modal-body">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function Settings({
  controller,
  open,
  onClose,
  theme,
  toggleTheme,
  palette,
  setPalette,
  onProviders,
  onInstructions,
}: {
  controller: SessionController;
  open: boolean;
  onClose: () => void;
  theme: string;
  toggleTheme: () => void;
  palette: string;
  setPalette: (value: string) => void;
  onProviders: () => void;
  onInstructions: () => void;
}) {
  const { state, connection } = controller;
  const { preferences } = useWorkspacePreferences();
  const personalInstructions = (
    <div className="settings-row">
      <span>
        <strong>Personal instructions</strong>
        <small>Your global agent rules, shared across projects.</small>
      </span>
      <button type="button" className="secondary-button" onClick={onInstructions}>
        Edit instructions
      </button>
    </div>
  );
  return (
    <Modal
      open={open}
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
      title="Settings"
      onEscapeKeyDown={(event) => {
        if (
          event.target instanceof Element &&
          event.target.closest('[data-settings-searching="true"]')
        )
          event.preventDefault();
      }}
      description="Appearance, agent behavior and workspace preferences."
      icon={<Settings2 size={20} />}
      detailToggle
      drawer
    >
      <SettingsSearch>
        {open && preferences.view === 'studio' && <RuntimeControls controller={controller} />}
        <div className="settings-row">
          <span>
            <strong>Appearance</strong>
            <small>
              {theme === 'dark'
                ? 'Soft charcoal surfaces with a quiet accent.'
                : 'Warm neutral surfaces with a quiet accent.'}
            </small>
          </span>
          <button type="button" className="secondary-button" onClick={toggleTheme}>
            {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
            {theme === 'dark' ? 'Light' : 'Dark'}
          </button>
        </div>
        <fieldset className="palette-options" aria-label="Color theme">
          {[
            ['sage', 'Forest'],
            ['ocean', 'Ocean'],
            ['amber', 'Amber'],
            ['violet', 'Violet'],
          ].map(([id, label]) => (
            <button
              type="button"
              key={id}
              data-palette={id}
              aria-pressed={palette === id}
              onClick={() => setPalette(id!)}
            >
              <span />
              {label}
            </button>
          ))}
        </fieldset>
        <div className="settings-row">
          <span>
            <strong>Connection</strong>
            <small>{state.cwd || 'Waiting for the workspace'}</small>
          </span>
          <span className="connection-chip">
            <span className={`status-dot ${connection === 'open' ? '' : 'error'}`} />
            {connection === 'open' ? 'Local' : 'Offline'}
          </span>
        </div>
        <div className="settings-row">
          <span>
            <strong>Providers & accounts</strong>
            <small>API keys, subscription sign-in and custom endpoints.</small>
          </span>
          <button type="button" className="secondary-button" onClick={onProviders}>
            <KeyRound size={15} />
            Manage
          </button>
        </div>
        {preferences.view === 'studio' ? (
          personalInstructions
        ) : (
          <details className="advanced-settings">
            <summary>
              <Settings2 size={16} />
              <span>A little more control</span>
              <small>Only if you need it</small>
            </summary>
            <div className="advanced-settings-body">
              <p>
                These settings change how your assistant works. Your everyday chat is ready without
                changing them.
              </p>
              <div className="settings-detail-choice">
                <span>How much detail would you like?</span>
                <DetailSwitch />
              </div>
              {open && <RuntimeControls controller={controller} />}
              {personalInstructions}
            </div>
          </details>
        )}
      </SettingsSearch>
      <p className="fine-print">
        VibeUI v{uiVersion} · WrongStack{' '}
        {state.appVersion ? `v${state.appVersion}` : 'version not reported'}
        {state.updateAvailable && state.latestVersion ? ` · v${state.latestVersion} available` : ''}
      </p>
    </Modal>
  );
}

export function PendingInteractions({ controller }: { controller: SessionController }) {
  const { state, connection } = controller;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!state.confirm?.deadlineAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [state.confirm?.deadlineAt]);
  const confirm = state.confirm;
  const expired = Boolean(confirm?.deadlineAt && confirm.deadlineAt <= now);
  const answer = (decision: 'yes' | 'no') => {
    if (confirm) controller.decideConfirmation(decision);
  };
  return (
    <>
      <Modal
        open={Boolean(confirm)}
        onOpenChange={() => {}}
        title="Your permission is needed"
        icon={<AlertCircle size={20} />}
        dismissible={false}
        description={`${confirm?.tool || 'A tool'} is waiting for your decision.`}
      >
        <CodePanel label="Tool arguments" value={confirm?.input ?? ''} defaultView="tree" />
        {expired && (
          <p role="status">This request has expired. Waiting for the agent to continue.</p>
        )}
        <div className="dialog-actions">
          <button
            type="button"
            className="secondary-button"
            disabled={connection !== 'open' || expired}
            onClick={() => answer('no')}
          >
            Deny
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={connection !== 'open' || expired}
            onClick={() => answer('yes')}
          >
            Allow once
          </button>
        </div>
      </Modal>
      {!confirm && state.inputs[0] && (
        <InputDialog
          key={state.inputs[0].id}
          request={state.inputs[0]}
          waiting={state.inputs.length - 1}
          controller={controller}
        />
      )}
    </>
  );
}

function InputDialog({
  request,
  waiting,
  controller,
}: {
  request: InputRequest;
  /** Further requests queued behind this one. */
  waiting: number;
  controller: SessionController;
}) {
  const { state, connection, send, notice } = controller;
  const [answers, setAnswers] = useState<Record<string, { selected: string[]; text: string }>>({});
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!sent) return;
    const timer = setTimeout(() => {
      setSent(false);
      setError('No confirmation received. You can retry.');
    }, 10_000);
    return () => clearTimeout(timer);
  }, [sent]);
  const submit = (cancelled = false) => {
    if (
      !cancelled &&
      request.questions.some(
        (q) => q.required && !answers[q.id]?.text.trim() && !answers[q.id]?.selected.length,
      )
    ) {
      setError('Please answer the required questions.');
      return;
    }
    if (
      send('user.input_submit', {
        sessionId: state.id,
        response: {
          requestId: request.id,
          status: cancelled ? 'cancelled' : 'submitted',
          answers: cancelled
            ? []
            : request.questions.map((q) => ({
                questionId: q.id,
                selectedOptionIds: answers[q.id]?.selected ?? [],
                text: answers[q.id]?.text.trim() || undefined,
                delegated: false,
                usedRecommendation: false,
              })),
        },
      })
    ) {
      setSent(true);
      notice('Answer sent. Waiting for the agent.');
    }
  };
  return (
    <Modal
      open
      onOpenChange={() => {}}
      title={request.title || 'A quick question'}
      dismissible={false}
      description="The agent needs your input to continue."
    >
      {waiting > 0 && (
        <p className="fine-print" role="status">
          {inputQueueLabel(waiting)}
        </p>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {request.questions.map((question) => (
          <fieldset className="input-question" key={question.id}>
            <legend>
              {question.prompt}
              {question.required ? ' *' : ''}
            </legend>
            {question.options.map((option) => (
              <label key={option.id}>
                <input
                  type={question.kind === 'multi_select' ? 'checkbox' : 'radio'}
                  name={question.id}
                  checked={answers[question.id]?.selected.includes(option.id) ?? false}
                  onChange={(event) =>
                    setAnswers((current) => {
                      const previous = current[question.id] ?? { selected: [], text: '' };
                      return {
                        ...current,
                        [question.id]: {
                          ...previous,
                          selected:
                            question.kind === 'multi_select'
                              ? event.target.checked
                                ? [...previous.selected, option.id]
                                : previous.selected.filter((id) => id !== option.id)
                              : [option.id],
                        },
                      };
                    })
                  }
                />
                {option.label}
              </label>
            ))}
            {question.allowCustom && (
              <textarea
                aria-label={`${question.prompt} — written answer`}
                placeholder={question.options.length ? 'Or write your own answer…' : 'Your answer…'}
                value={answers[question.id]?.text ?? ''}
                onChange={(event) =>
                  setAnswers((current) => ({
                    ...current,
                    [question.id]: {
                      selected: current[question.id]?.selected ?? [],
                      text: event.target.value,
                    },
                  }))
                }
              />
            )}
          </fieldset>
        ))}
        {error && (
          <p className="form-error" role="alert">
            <AlertCircle size={14} />
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button
            type="button"
            className="secondary-button"
            disabled={connection !== 'open' || sent}
            onClick={() => submit(true)}
          >
            Cancel request
          </button>
          <button type="submit" className="primary-button" disabled={connection !== 'open' || sent}>
            <Check size={14} />
            {sent ? 'Sending…' : 'Send answer'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
