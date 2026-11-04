import type { ParsedNextStep } from '@wrongstack/webui-protocol';
import { ArrowUp, Lightbulb, Plus } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import './next-steps.css';

/**
 * Suggestions come only from the engine's completed turn, never generated locally. As in the
 * WebUI, chosen steps and an optional message of your own are sent together in one click, or
 * added to the draft to edit first.
 */
export function NextStepsPanel({
  steps,
  onAdd,
  onSend,
  sending = false,
}: {
  steps: readonly ParsedNextStep[];
  onAdd: (text: string) => void;
  /** Sends the text as the next prompt; resolves false when it was not sent. */
  onSend?: ((text: string) => Promise<boolean>) | undefined;
  sending?: boolean | undefined;
}) {
  const { t } = useDesktopText();
  const [selected, setSelected] = useState<number[]>([]);
  const [message, setMessage] = useState('');
  const messageId = useId();
  useEffect(() => {
    setSelected([]);
    setMessage('');
  }, [steps]);
  const chosen = steps.filter((step) => selected.includes(step.index)).map((step) => step.text);
  const batch = message.trim() ? [...chosen, message.trim()] : chosen;
  return (
    <details className="next-steps-panel">
      <summary>
        <Lightbulb size={14} /> {t('nextSteps.title')} <small>{steps.length}</small>
      </summary>
      <div className="next-steps-body">
        <p>{t('nextSteps.body')}</p>
        {steps.map((step) => (
          <label key={step.index} className="next-step">
            <input
              type="checkbox"
              checked={selected.includes(step.index)}
              onChange={(event) =>
                setSelected((old) =>
                  event.target.checked
                    ? [...old, step.index]
                    : old.filter((id) => id !== step.index),
                )
              }
            />
            <span>{step.text}</span>
          </label>
        ))}
        {onSend && (
          <label className="next-steps-message" htmlFor={messageId}>
            {t('nextSteps.message')}
            <textarea
              id={messageId}
              rows={2}
              value={message}
              placeholder={t('nextSteps.placeholder')}
              onChange={(event) => setMessage(event.target.value)}
            />
          </label>
        )}
        <div className="next-steps-actions">
          <button
            type="button"
            className="button secondary small"
            disabled={!batch.length}
            onClick={() => {
              onAdd(batch.join('\n'));
              setSelected([]);
              setMessage('');
            }}
          >
            <Plus size={13} /> {t('nextSteps.add')}
          </button>
          {onSend && (
            <button
              type="button"
              className="button small"
              disabled={!batch.length || sending}
              onClick={() =>
                void onSend(batch.join('\n')).then((sent) => {
                  if (!sent) return;
                  setSelected([]);
                  setMessage('');
                })
              }
            >
              <ArrowUp size={13} />{' '}
              {t(batch.length === 1 ? 'nextSteps.sendOne' : 'nextSteps.sendMany', {
                count: batch.length,
              })}
            </button>
          )}
        </div>
      </div>
    </details>
  );
}
