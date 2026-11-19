import {
  AlertTriangle,
  Check,
  Clock3,
  FileCode2,
  Globe,
  ShieldAlert,
  Terminal,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { DiffPreview } from './DiffPreview';
import { useDesktopText } from './desktop-i18n';
import type { EngineSend } from './engine-operations';
import { record } from './engine-values';
import { toolInputHint, toolInputView } from './tool-input-view';

/** How long a card that just became first ignores Y/N, so no key lands on an unseen call. */
export const SHORTCUT_ARM_MS = 600;

import './tool-approval.css';

type Decision = 'yes' | 'no' | 'deny' | 'always-exact' | 'always-command' | 'always-tool';
function label(key: string) {
  return key.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
}
export function StructuredToolValue({ value }: { value: unknown }) {
  const { t } = useDesktopText();
  if (value === null) return <span className="approval-empty">{t('value.none')}</span>;
  if (Array.isArray(value))
    return value.length ? (
      <ol>
        {value.map((item, index) => (
          <li key={index}>
            <StructuredToolValue value={item} />
          </li>
        ))}
      </ol>
    ) : (
      <span className="approval-empty">{t('value.emptyList')}</span>
    );
  if (typeof value === 'object' && value !== null) {
    const fields = Object.entries(value);
    return fields.length ? (
      <dl>
        {fields.map(([key, item]) => (
          <div key={key}>
            <dt>{label(key)}</dt>
            <dd>
              <StructuredToolValue value={item} />
            </dd>
          </div>
        ))}
      </dl>
    ) : (
      <span className="approval-empty">{t('value.emptyObject')}</span>
    );
  }
  if (typeof value === 'string') return <pre>{value || t('value.emptyText')}</pre>;
  return <span>{String(value)}</span>;
}

export function ToolApprovalCard({
  approval,
  send,
  connected,
  shortcuts = false,
}: {
  approval: Record<string, unknown>;
  send: EngineSend;
  connected: boolean;
  /** Y/N decide this card (the first one waiting); never for a destructive call. */
  shortcuts?: boolean | undefined;
}) {
  const { t } = useDesktopText();
  const [scope, setScope] = useState<'always-exact' | 'always-command' | 'always-tool'>(
    'always-exact',
  );
  const [pending, setPending] = useState(false),
    [error, setError] = useState(''),
    [now, setNow] = useState(Date.now());
  const pendingRef = useRef(false),
    alive = useRef(true),
    timer = useRef<ReturnType<typeof setTimeout> | null>(null),
    card = useRef<HTMLElement>(null),
    decideRef = useRef<(decision: Decision) => Promise<void>>(async () => {});
  const id = String(approval['id'] ?? ''),
    tool = String(approval['toolName'] ?? 'Tool');
  const input = record(approval['input']);
  const commandKey = ['command', 'cmd', 'script'].find(
    (key) => typeof input[key] === 'string' && input[key],
  );
  const command = commandKey ? input[commandKey] : undefined;
  const remainingInput = commandKey
    ? Object.fromEntries(Object.entries(input).filter(([key]) => key !== commandKey))
    : approval['input'];
  const path = String(input['file_path'] ?? input['path'] ?? '');
  const oldText = input['old_string'],
    newText = input['new_string'];
  const edit =
    /^(edit|str_replace|edit_file|multi_edit)$/i.test(tool) &&
    typeof oldText === 'string' &&
    typeof newText === 'string';
  const canShowDiff = edit && oldText !== newText && oldText.length + newText.length <= 200000;
  const isRule = approval['decisionSource'] === 'yolo_user_rule';
  const destructive =
    approval['riskTier'] === 'destructive' || approval['decisionSource'] === 'yolo_destructive';
  const reason = typeof approval['boundaryReason'] === 'string' ? approval['boundaryReason'] : '';
  const deadline = typeof approval['deadlineAt'] === 'number' ? approval['deadlineAt'] : null;
  const seconds = deadline === null ? null : Math.max(0, Math.ceil((deadline - now) / 1000));
  const Icon = /edit|write|create|patch/i.test(tool)
    ? FileCode2
    : /bash|shell|exec|command/i.test(tool)
      ? Terminal
      : /fetch|http|web|request/i.test(tool)
        ? Globe
        : ShieldAlert;
  useEffect(() => {
    if (deadline === null) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [deadline]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);
  const decide = async (decision: Decision) => {
    if (!id || !connected || pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError('');
    try {
      await send('tool.confirm_result', { id, decision });
      if (!alive.current) return;
      // A transport write is not the decision. Keep the card until the engine
      // broadcasts tool.confirm_resolved; allow a retry if no resolution arrives.
      timer.current = setTimeout(() => {
        pendingRef.current = false;
        setPending(false);
        setError(t('approval.notConfirmed'));
      }, 15000);
    } catch (e) {
      if (!alive.current) return;
      pendingRef.current = false;
      setPending(false);
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  decideRef.current = decide;
  const keys = shortcuts && !destructive && connected && !!id;
  useEffect(() => {
    if (!keys) return;
    // A card that just became the first one (the previous was decided) ignores keys briefly,
    // so a second quick Y can never approve a call the reader has not seen yet.
    const armedAt = Date.now() + SHORTCUT_ARM_MS;
    const onKey = (event: KeyboardEvent) => {
      if (Date.now() < armedAt) return;
      const decision = approvalShortcut(event, card.current);
      if (!decision) return;
      event.preventDefault();
      void decideRef.current(decision);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [keys]);
  const busy = pending || !connected || !id;
  const risk = destructive
    ? t('approval.risk.destructive')
    : approval['riskTier'] === 'safe'
      ? t('approval.risk.safe')
      : t('approval.risk.standard');
  const ask =
    typeof command === 'string' && command
      ? t('approval.ask.command')
      : edit
        ? t('approval.ask.edit')
        : /^(write|write_file|create_file)$/i.test(tool)
          ? t('approval.ask.write')
          : /^(fetch|web_fetch|http|http_request|browser)/i.test(tool)
            ? t('approval.ask.web')
            : t('approval.ask.tool', { tool });
  // What is being approved is shown whole: a command with every argument (exec's args joined
  // and quoted as typed), wrapped rather than cut; a path; or the tool's main target.
  const view = toolInputView(tool, input);
  const shownCommand =
    view.kind === 'command' ? view.command : typeof command === 'string' ? command : '';
  const subject = shownCommand || path || toolInputHint(tool, input);
  // Arguments the banner cannot summarise stay in view for anything destructive or unfamiliar.
  const openDetails = destructive || (!shownCommand && !edit && view.kind !== 'write');
  return (
    <article
      ref={card}
      className={`approval-card tool-approval approval-banner ${destructive ? 'approval-destructive' : ''}`}
      aria-label={t('approval.label', { tool })}
      data-approval-shortcuts={keys ? '' : undefined}
    >
      <div className="approval-banner-row">
        <span className="approval-banner-icon">
          {destructive ? <ShieldAlert size={16} /> : <Icon size={16} />}
        </span>
        <div className="approval-banner-text">
          <span className="approval-banner-eyebrow">
            {t('approval.eyebrow')} · <span className="approval-risk">{risk}</span> · {tool}
          </span>
          <strong className="approval-banner-title">{ask}</strong>
          {subject ? (
            <code className={`approval-banner-subject${shownCommand ? ' command' : ''}`}>
              {subject}
            </code>
          ) : null}
        </div>
        <div className="approval-banner-actions" title={keys ? t('approval.shortcuts') : undefined}>
          <button
            type="button"
            className="button primary small"
            disabled={busy}
            onClick={() => void decide('yes')}
          >
            <Check size={13} /> {t('approval.allowOnce')}
            {keys ? (
              <span className="approval-key" aria-hidden="true">
                Y
              </span>
            ) : null}
          </button>
          <button
            type="button"
            className="button secondary small"
            disabled={busy}
            title={t('approval.denyTitle')}
            onClick={() => void decide('no')}
          >
            <X size={13} /> {t('approval.deny')}
            {keys ? (
              <span className="approval-key" aria-hidden="true">
                N
              </span>
            ) : null}
          </button>
          {!isRule && (
            <button
              type="button"
              className="button secondary small"
              disabled={busy}
              title={t(`approval.scope.${scopeKey(scope)}`, { tool })}
              onClick={() => void decide(scope)}
            >
              {t('approval.allowRemember')}
            </button>
          )}
        </div>
      </div>
      {reason && <p className="approval-banner-reason">{reason}</p>}
      {isRule && (
        <p className="approval-notice">
          <AlertTriangle size={14} /> {t('approval.rule')}
        </p>
      )}
      {seconds !== null && (
        <p className="approval-deadline" role="status">
          <Clock3 size={13} />{' '}
          {seconds
            ? t('approval.window', {
                time: `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`,
              })
            : t('approval.waitingDecision')}
        </p>
      )}
      {canShowDiff && (
        <section className="approval-diff" aria-label={t('approval.diffLabel')}>
          <strong>{t('approval.diff')}</strong>
          <DiffPreview before={oldText} after={newText} path={path || t('approval.file')} />
        </section>
      )}
      {error && (
        <p className="composer-error" role="alert">
          {error}
        </p>
      )}
      {pending && (
        <p role="status" className="approval-waiting">
          {t('approval.sending')}
        </p>
      )}
      <details className="approval-details" open={openDetails || undefined}>
        <summary>{t('approval.details')}</summary>
        <p>{t('approval.review')}</p>
        {typeof command === 'string' && command && (
          <section className="approval-command" aria-label={t('approval.commandLabel')}>
            <strong>{t('approval.command')}</strong>
            <pre>{command}</pre>
          </section>
        )}
        {approval['input'] !== undefined && (
          <section className="approval-arguments" aria-label={t('approval.args')}>
            <strong>{t('approval.args')}</strong>
            <StructuredToolValue value={remainingInput} />
          </section>
        )}
        {typeof approval['suggestedPattern'] === 'string' && approval['suggestedPattern'] && (
          <div className="approval-pattern">
            <strong>{t('approval.pattern')}</strong>
            <code>{approval['suggestedPattern']}</code>
          </div>
        )}
        {!isRule && (
          <label className="approval-scope">
            {t('approval.remember')}
            <select
              value={scope}
              disabled={busy}
              onChange={(event) => setScope(event.target.value as typeof scope)}
              aria-label={t('approval.scopeLabel')}
            >
              <option value="always-exact">{t('approval.scope.exact')}</option>
              {tool === 'exec' && (
                <option value="always-command">{t('approval.scope.command')}</option>
              )}
              <option value="always-tool">{t('approval.scope.tool', { tool })}</option>
            </select>
            <small>{t('approval.saved')}</small>
          </label>
        )}
        <p className="approval-decision-hint">{t('approval.hint')}</p>
        <footer className="approval-actions">
          <button
            type="button"
            className="button secondary small"
            title={t('approval.rememberDenialTitle')}
            disabled={busy}
            onClick={() => void decide('deny')}
          >
            {t('approval.rememberDenial')}
          </button>
        </footer>
      </details>
    </article>
  );
}

function scopeKey(scope: 'always-exact' | 'always-command' | 'always-tool') {
  return scope === 'always-exact' ? 'exact' : scope === 'always-command' ? 'command' : 'tool';
}

/**
 * The decision a key press asks of the approval card: Y allows once, N denies. Only a bare key
 * pressed outside any text field, select, editable region or open dialog counts, and only while
 * the card is on screen, so typing in the composer can never approve a call.
 */
export function approvalShortcut(
  event: Pick<
    KeyboardEvent,
    | 'key'
    | 'target'
    | 'defaultPrevented'
    | 'repeat'
    | 'isComposing'
    | 'ctrlKey'
    | 'metaKey'
    | 'altKey'
    | 'shiftKey'
  >,
  card: HTMLElement | null,
): 'yes' | 'no' | null {
  if (
    event.defaultPrevented ||
    event.repeat ||
    event.isComposing ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    event.shiftKey
  )
    return null;
  const key = event.key.toLowerCase();
  if (key !== 'y' && key !== 'n') return null;
  const target = event.target as HTMLElement | null;
  if (
    target &&
    typeof target.closest === 'function' &&
    (target.isContentEditable ||
      target.closest('input, textarea, select, [contenteditable], [role="dialog"], dialog'))
  )
    return null;
  if (!card?.isConnected || card.getClientRects().length === 0) return null;
  if (card.ownerDocument.querySelector('[aria-modal="true"], dialog[open]')) return null;
  // Two conversations showing a card each would make one key press ambiguous: decide neither.
  const shown = [...card.ownerDocument.querySelectorAll('[data-approval-shortcuts]')].filter(
    (element) => element.getClientRects().length > 0,
  );
  if (shown.some((element) => element !== card)) return null;
  return key === 'y' ? 'yes' : 'no';
}
