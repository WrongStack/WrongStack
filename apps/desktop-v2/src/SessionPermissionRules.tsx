import { ShieldCheck, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import { runEngineText } from './engine-command-run';
import type { EngineCommand } from './engine-operations';
import { Modal } from './Modal';
import {
  parseSessionRules,
  permissionRuleArgs,
  type SessionRuleRow,
} from './session-permission-model';
import './session-permissions.css';

/**
 * The permission rules of one conversation, through the engine's `/permissions` command: the
 * allow and deny rules it holds, a form to add one, removal by number and clearing. The rules
 * belong to that conversation: they are saved with the session and written to no config.
 * Whether a rule was accepted (an unknown tool, a duplicate) is the command's own message,
 * shown as it came after the list reloads.
 */
export function SessionPermissionRules({
  command,
  sessionId,
  onClose,
}: {
  command: EngineCommand;
  /** The conversation the rules belong to. */
  sessionId: string;
  onClose: () => void;
}) {
  const { t } = useDesktopText();
  const [rows, setRows] = useState<SessionRuleRow[]>([]);
  const [effect, setEffect] = useState<'allow' | 'deny'>('deny');
  const [tool, setTool] = useState('');
  const [pattern, setPattern] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [rules, setRules] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const outcome = await runEngineText(command, 'permissions', 'list', sessionId);
    if (outcome.error) setError(outcome.error);
    else setRows(parseSessionRules(outcome.text));
  }, [command, sessionId]);
  useEffect(() => {
    void load();
  }, [load]);
  const act = async (args: string, after?: () => void) => {
    setBusy(true);
    setError('');
    const outcome = await runEngineText(command, 'permissions', args, sessionId);
    if (outcome.error) setError(outcome.error);
    else {
      setNotice(outcome.text);
      after?.();
    }
    await load();
    setBusy(false);
  };
  const add = () => {
    const args = permissionRuleArgs(effect, tool, pattern);
    if (!args) return setError(t('sessionPermissions.toolInvalid'));
    void act(args, () => {
      setTool('');
      setPattern('');
    });
  };
  const showRules = async () => {
    setBusy(true);
    setError('');
    const outcome = await runEngineText(command, 'permissions', 'rules', sessionId);
    if (outcome.error) setError(outcome.error);
    else setRules(outcome.text);
    setBusy(false);
  };
  return (
    <Modal onClose={onClose} title={t('sessionPermissions.title')}>
      <div className="session-permissions">
        <header>
          <h2>
            <ShieldCheck size={18} /> {t('sessionPermissions.title')}
          </h2>
          <button
            type="button"
            className="icon-button"
            aria-label={t('sessionPermissions.close')}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        <p className="field-help">{t('sessionPermissions.intro')}</p>
        {rows.length === 0 ? (
          <p className="field-help">{t('sessionPermissions.empty')}</p>
        ) : (
          <ul className="session-permissions-rules">
            {rows.map((row) => (
              <li key={row.n} data-effect={row.effect}>
                <strong>
                  {row.effect === 'allow'
                    ? t('sessionPermissions.allow')
                    : t('sessionPermissions.deny')}
                </strong>
                <code>{row.tool}</code>
                <span>{row.pattern ?? t('sessionPermissions.anyInput')}</span>
                <button
                  type="button"
                  className="button"
                  disabled={busy}
                  aria-label={t('sessionPermissions.remove', { n: row.n })}
                  onClick={() => void act(`remove ${row.n}`)}
                >
                  <Trash2 size={13} />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="session-permissions-row">
          <select
            value={effect}
            aria-label={t('sessionPermissions.effect')}
            onChange={(event) => setEffect(event.target.value as 'allow' | 'deny')}
          >
            <option value="deny">{t('sessionPermissions.deny')}</option>
            <option value="allow">{t('sessionPermissions.allow')}</option>
          </select>
          <input
            type="text"
            value={tool}
            placeholder={t('sessionPermissions.tool')}
            aria-label={t('sessionPermissions.tool')}
            onChange={(event) => setTool(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') add();
            }}
          />
          <input
            type="text"
            value={pattern}
            placeholder={t('sessionPermissions.pattern')}
            aria-label={t('sessionPermissions.pattern')}
            onChange={(event) => setPattern(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') add();
            }}
          />
          <button type="button" className="button primary" disabled={busy} onClick={add}>
            {t('sessionPermissions.add')}
          </button>
        </div>
        <div className="session-permissions-row">
          <button type="button" className="button" disabled={busy} onClick={() => void showRules()}>
            {t('sessionPermissions.showRules')}
          </button>
          {rows.length > 0 && (
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => void act('clear')}
            >
              <Trash2 size={14} /> {t('sessionPermissions.clear')}
            </button>
          )}
        </div>
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        {notice && <p className="field-help">{notice}</p>}
        {rules && <pre className="session-permissions-output">{rules}</pre>}
      </div>
    </Modal>
  );
}
