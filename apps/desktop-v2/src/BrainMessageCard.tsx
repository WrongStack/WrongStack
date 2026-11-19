import { Brain, CircleHelp, Clock3 } from 'lucide-react';
import type { BrainMessage } from './brain-message';
import { ChatEventCard, type ChatEventTone } from './ChatEventCard';
import { useDesktopText } from './desktop-i18n';

const TONES: Record<string, ChatEventTone> = {
  answered: 'success',
  denied: 'danger',
  ask_human: 'warning',
  intervention: 'accent',
  check: 'neutral',
};
/** The decision's facts, shown as small labelled chips under its answer. */
const FACTS = ['source', 'risk', 'tier', 'decisionType', 'optionId'] as const;

/**
 * A Brain decision in the conversation: what was asked, what the Brain answered (or why it
 * refused), its reasoning, and the facts behind it. Confidence shows only when the decision
 * carried one.
 */
export function BrainMessageCard({ decision }: { decision: BrainMessage }) {
  const { t } = useDesktopText();
  const facts = FACTS.filter((field) => decision[field]);
  const reasoning = decision.rationale || decision.reason;
  return (
    <ChatEventCard
      tone={TONES[decision.kind] ?? 'neutral'}
      attention={decision.kind === 'ask_human' && decision.pending === true}
      className="chat-brain"
      label={t('brainMessage.title')}
      data={{ 'data-brain-decision': decision.id }}
      icon={<Brain size={15} />}
      title={t('brainMessage.title')}
      meta={t(`brainMessage.kind.${decision.kind}`, { defaultValue: decision.kind })}
      badge={
        decision.pending ? (
          <span className="chat-event-chip pending" role="status">
            <Clock3 size={11} /> {t('brainMessage.waiting')}
          </span>
        ) : decision.confidence !== undefined ? (
          <span
            className="chat-event-chip"
            title={t('brainMessage.confidence')}
            style={{ ['--confidence' as string]: `${Math.round(decision.confidence * 100)}%` }}
          >
            {t('brainMessage.confidence')} {Math.round(decision.confidence * 100)}%
            <i className="chat-brain-meter" aria-hidden="true" />
          </span>
        ) : null
      }
    >
      {decision.question && (
        <p className="chat-brain-question">
          <CircleHelp size={13} aria-hidden="true" />
          <span className="sr-label">{t('brainMessage.question')}: </span>
          {decision.question}
        </p>
      )}
      {decision.text && (
        <p className="chat-brain-answer">
          <span className="sr-label">{t('brainMessage.text')}: </span>
          {decision.text}
        </p>
      )}
      {reasoning && (
        <p className="chat-brain-reason">
          <span className="sr-label">
            {t(decision.rationale ? 'brainMessage.rationale' : 'brainMessage.reason')}:{' '}
          </span>
          {reasoning}
        </p>
      )}
      {decision.rationale && decision.reason && (
        <p className="chat-brain-reason">
          <span className="sr-label">{t('brainMessage.reason')}: </span>
          {decision.reason}
        </p>
      )}
      {facts.length > 0 && (
        <dl className="chat-event-facts">
          {facts.map((field) => (
            <div
              key={field}
              className={`fact-${field} value-${String(decision[field])
                .toLowerCase()
                .replace(/[^a-z0-9_-]+/g, '-')}`}
            >
              <dt>{t(`brainMessage.${field}`)}</dt>
              <dd>{decision[field]}</dd>
            </div>
          ))}
        </dl>
      )}
      {decision.kind === 'ask_human' && decision.pending === false && (
        <p className="chat-event-note">{t('brainMessage.closed')}</p>
      )}
    </ChatEventCard>
  );
}
