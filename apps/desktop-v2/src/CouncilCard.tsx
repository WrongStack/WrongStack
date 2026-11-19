import { CouncilDecisionCard } from '@wrongstack/project-surfaces/council/CouncilDecisionCard';
import type { CouncilDecisionData } from '@wrongstack/project-surfaces/council/types';
import { CircleHelp, LoaderCircle, Scale, ShieldX } from 'lucide-react';
import { I18nextProvider } from 'react-i18next';
import { ChatEventCard } from './ChatEventCard';
import { stepSeconds } from './chat-steps-model';
import { councilTally, councilVetoed, seatVote } from './council-summary';
import { useDesktopText } from './desktop-i18n';
import { LazyDetails } from './LazyDetails';
import { surfaceI18n } from './surface-i18n';
import './surfaces.css';

/**
 * A Brain council's decision in the conversation: the question, the verdict, how the seats
 * voted (a bar by option and one chip per seat), and the WebUI's full council report one
 * disclosure away. While the council votes, seats that have not answered show as voting.
 * Loaded on first use, so the shared stylesheet stays out of the chat's startup bundle.
 */
export default function CouncilCard({ decision }: { decision: CouncilDecisionData }) {
  const { t } = useDesktopText();
  const seats = decision.seats ?? [];
  const voting = decision.phase === 'voting';
  const total = decision.configuredSeatCount ?? seats.length;
  const valid = decision.validVoteCount ?? seats.filter((seat) => seat.status === 'valid').length;
  const denied = decision.status === 'denied' || councilVetoed(decision);
  const tally = councilTally(seats);
  const verdict = `${decision.resolution ?? decision.status ?? 'decided'}${
    decision.optionId ? ` · ${decision.optionId}` : ''
  }`;
  return (
    <ChatEventCard
      tone={voting ? 'accent' : denied ? 'danger' : 'success'}
      className="chat-brain chat-council"
      label={t('councilCard.title')}
      data={decision.requestId ? { 'data-council-request': decision.requestId } : undefined}
      icon={denied ? <ShieldX size={15} /> : <Scale size={15} />}
      title={t('councilCard.title')}
      meta={[
        t('councilCard.seats', { valid, total }),
        decision.durationMs !== undefined ? stepSeconds(decision.durationMs) : '',
      ]
        .filter(Boolean)
        .join(' · ')}
      badge={
        voting ? (
          <span className="chat-event-chip" role="status">
            <LoaderCircle size={11} className="spin" /> {t('councilCard.voting')}
          </span>
        ) : (
          <span className="chat-event-chip chat-council-verdict">{verdict}</span>
        )
      }
    >
      {decision.question && (
        <p className="chat-brain-question">
          <CircleHelp size={13} aria-hidden="true" />
          {decision.question}
        </p>
      )}
      {decision.reason && <p className="chat-brain-reason">{decision.reason}</p>}
      {tally.length > 0 && (
        <div className="chat-council-tally">
          <div className="chat-council-bar" aria-hidden="true">
            {tally.map((item, index) => (
              <i
                key={item.option}
                className={`option-${index % 4}`}
                style={{ width: `${item.percent}%` }}
              />
            ))}
          </div>
          <ul className="chat-council-legend">
            {tally.map((item, index) => (
              <li key={item.option} className={`option-${index % 4}`}>
                <b>{item.option}</b> {item.percent}%
                <small>
                  {' · '}
                  {t(item.count === 1 ? 'councilCard.vote' : 'councilCard.votes', {
                    count: item.count,
                  })}
                </small>
              </li>
            ))}
          </ul>
        </div>
      )}
      {seats.length > 0 && (
        <ul className="chat-council-seats">
          {seats.map((seat) => (
            <li
              key={seat.seatId}
              className={`chat-council-seat status-${seat.status}${seat.veto ? ' veto' : ''}`}
              title={seat.rationale ?? seat.stance ?? seat.error ?? undefined}
            >
              <strong>{seat.persona}</strong>
              {seat.model ? <code>{seat.model}</code> : null}
              {seat.status === 'valid' ? (
                <span className="chat-council-vote">{seatVote(seat)}</span>
              ) : voting && !seat.error ? (
                <span className="chat-council-vote pending">
                  <LoaderCircle size={10} className="spin" /> {t('councilCard.seatVoting')}
                </span>
              ) : (
                <span className="chat-council-vote failed">{t('councilCard.noVote')}</span>
              )}
              {seat.veto ? (
                <span className="chat-council-veto">{t('councilCard.veto')}</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <LazyDetails
        className="chat-council-full"
        summary={<summary>{t('councilCard.full')}</summary>}
      >
        <I18nextProvider i18n={surfaceI18n}>
          <div className="ws-surfaces">
            <CouncilDecisionCard decision={decision} />
          </div>
        </I18nextProvider>
      </LazyDetails>
    </ChatEventCard>
  );
}
