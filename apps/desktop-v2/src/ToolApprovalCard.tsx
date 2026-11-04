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
}: {
  approval: Record<string, unknown>;
  send: EngineSend;
  connected: boolean;
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
    timer = useRef<ReturnType<typeof setTimeout> | null>(null);
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
  return (
    <article
      className={`approval-card tool-approval ${destructive ? 'approval-destructive' : ''}`}
      aria-label={t('approval.label', { tool })}
    >
      <header>
        <div className="approval-icon">
          <Icon size={18} />
        </div>
        <div>
          <span className="eyebrow">{t('approval.eyebrow')}</span>
          <h3>{tool}</h3>
          <p>{reason || t('approval.review')}</p>
        </div>
        <span className="approval-risk">
          {destructive
            ? t('approval.risk.destructive')
            : approval['riskTier'] === 'safe'
              ? t('approval.risk.safe')
              : t('approval.risk.standard')}
        </span>
      </header>
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
      {typeof command === 'string' && command && (
        <section className="approval-command" aria-label={t('approval.commandLabel')}>
          <strong>{t('approval.command')}</strong>
          <pre>{command}</pre>
        </section>
      )}
      {canShowDiff && (
        <section className="approval-diff" aria-label={t('approval.diffLabel')}>
          <strong>{t('approval.diff')}</strong>
          <DiffPreview before={oldText} after={newText} path={path || t('approval.file')} />
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
            disabled={pending || !connected || !id}
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
      <p className="approval-decision-hint">{t('approval.hint')}</p>
      <footer className="approval-actions">
        <button
          type="button"
          className="button secondary"
          title={t('approval.rememberDenialTitle')}
          disabled={pending || !connected || !id}
          onClick={() => void decide('deny')}
        >
          {t('approval.rememberDenial')}
        </button>
        <button
          type="button"
          className="button secondary"
          disabled={pending || !connected || !id}
          title={t('approval.denyTitle')}
          onClick={() => void decide('no')}
        >
          <X size={14} /> {t('approval.deny')}
        </button>
        {!isRule && (
          <button
            type="button"
            className="button secondary"
            disabled={pending || !connected || !id}
            onClick={() => void decide(scope)}
          >
            {t('approval.allowRemember')}
          </button>
        )}
        <button
          type="button"
          className="button primary"
          disabled={pending || !connected || !id}
          onClick={() => void decide('yes')}
        >
          <Check size={14} /> {t('approval.allowOnce')}
        </button>
      </footer>
    </article>
  );
}
