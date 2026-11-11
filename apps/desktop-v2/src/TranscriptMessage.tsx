import { parseBugHuntMessage } from '@wrongstack/project-surfaces/lib/bug-hunt-message';
import {
  PERF_RUN_METRIC_LABELS,
  PERF_RUN_MODE_LABELS,
  parsePerfRunMessage,
} from '@wrongstack/project-surfaces/lib/perf-run-message';
import { stripNextStepsBlock } from '@wrongstack/webui-protocol';
import { Code2, Pencil, Pin, PinOff, RotateCcw } from 'lucide-react';
import { lazy, type ReactNode, Suspense, useState } from 'react';
import { BrainMessageCard } from './BrainMessageCard';
import { replayedBrainMessage } from './brain-message';
import { ChimeraMessageCard } from './ChimeraMessageCard';
import { AttachmentPreview } from './ComposerAttachments';
import { CopyButton } from './CopyButton';
import { referenceKey, referenceLabel, splitReferenceMessage } from './composer-resources-model';
import {
  type ConversationDisplay,
  conversationAppearanceDefaults,
} from './conversation-appearance';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand } from './engine-operations';
import type { EngineState } from './engine-state';
import { HuntRoundCard } from './HuntRounds';
import { MarkdownContent } from './MarkdownContent';
import type { MessageAction } from './message-action';
import { LiveRunActivity, TurnTools } from './TurnTools';
import './transcript-message.css';

const CouncilCard = lazy(() => import('./CouncilCard'));

type Message = EngineState['messages'][number];

export type { MessageAction } from './message-action';

/**
 * One message of the conversation with its actions: copy; a prompt can be taken back into the
 * composer; the latest answer can be asked again; an answer can show its Markdown source.
 */
export function TranscriptMessage({
  message,
  display = conversationAppearanceDefaults,
  state,
  projectRoot,
  onLink,
  onOpenFile,
  onOpenDesign,
  command,
  edit,
  askAgain,
  mark,
  day,
  activityLive = false,
  chimeraAction,
  pin,
  onOpenChimera,
}: {
  message: Message;
  display?: ConversationDisplay | undefined;
  state: Pick<EngineState, 'turnActivity' | 'turnStats'>;
  projectRoot?: string | null | undefined;
  onLink: (href: string) => void;
  onOpenFile: (path: string) => void;
  onOpenDesign?: (() => void) | undefined;
  /** The conversation's engine, for the pictures a turn's tools saved. */
  command?: EngineCommand | undefined;
  /** Puts this prompt into the composer. */
  edit?: MessageAction | undefined;
  /** Sends the prompt that produced this answer again. */
  askAgain?: MessageAction | undefined;
  /** How Find in conversation marks this message. */
  mark?: 'current' | 'match' | undefined;
  /** A day separator to show before the message. */
  day?: string | undefined;
  activityLive?: boolean | undefined;
  chimeraAction?: MessageAction | undefined;
  pin?: { active: boolean; toggle: () => void } | undefined;
  onOpenChimera?: (() => void) | undefined;
}) {
  const { t } = useDesktopText();
  const [source, setSource] = useState(false);
  const user = message.role === 'user';
  const brain =
    !user && !message.council ? (message.brain ?? replayedBrainMessage(message.text)) : null;
  const answer = !user && !message.council && !message.chimera && !brain;
  return (
    <>
      {day && (
        <div className="chat-day">
          <span>{day}</span>
        </div>
      )}
      <article
        className={`chat-message ${message.role}${mark ? ` find-${mark}` : ''}`}
        data-message-id={message.id}
      >
        <header className={user ? 'user-chat-label' : undefined}>
          <span>
            {user ? t('message.you') : 'WrongStack'}
            {message.at && (
              <time
                dateTime={new Date(message.at).toISOString()}
                title={new Date(message.at).toLocaleString()}
              >
                {new Date(message.at).toLocaleTimeString(undefined, {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </time>
            )}
          </span>
          <span className="message-actions">
            {pin && (
              <button
                type="button"
                className="copy-button"
                aria-pressed={pin.active}
                onClick={pin.toggle}
                title={t(pin.active ? 'messagePins.unpin' : 'messagePins.pin')}
              >
                {pin.active ? <PinOff size={12} /> : <Pin size={12} />}
                <span>{t(pin.active ? 'messagePins.unpin' : 'messagePins.pin')}</span>
              </button>
            )}
            {edit && (
              <ActionButton action={edit} label={t('message.edit')} title={t('message.editTitle')}>
                <Pencil size={12} />
              </ActionButton>
            )}
            {askAgain && (
              <ActionButton
                action={askAgain}
                label={t('message.askAgain')}
                title={t('message.askAgainTitle')}
              >
                <RotateCcw size={12} />
              </ActionButton>
            )}
            {answer && (
              <button
                type="button"
                className="copy-button"
                aria-pressed={source}
                title={source ? t('message.showFormatted') : t('message.showSource')}
                onClick={() => setSource(!source)}
              >
                <Code2 size={12} />{' '}
                <span>{source ? t('message.formatted') : t('message.source')}</span>
              </button>
            )}
            <CopyButton text={message.text} label={t('message.copy')} />
          </span>
        </header>
        <div className={user ? 'user-chat-body' : undefined}>
          {message.chimera ? (
            <ChimeraMessageCard
              reportId={message.chimera.reportId}
              text={message.text}
              action={chimeraAction}
              onOpen={onOpenChimera}
            />
          ) : message.council ? (
            <Suspense fallback={<MarkdownContent text={message.text} onLink={onLink} />}>
              <CouncilCard decision={message.council} />
            </Suspense>
          ) : brain ? (
            <BrainMessageCard decision={brain} />
          ) : answer && source ? (
            <pre className="message-source">{message.text}</pre>
          ) : answer ? (
            <MarkdownContent text={stripNextStepsBlock(message.text)} onLink={onLink} />
          ) : (
            <UserComposerMessage text={message.text} />
          )}
          {!!message.attachments?.length && <AttachmentPreview items={message.attachments} />}
        </div>
        {state.turnStats[message.id] && (
          <TurnTools
            display={display}
            events={[]}
            stats={state.turnStats[message.id]}
            onOpenFile={onOpenFile}
            command={command}
          />
        )}
      </article>
      {!!message.activityAfter?.length && (
        <LiveRunActivity
          display={display}
          events={message.activityAfter}
          projectRoot={projectRoot}
          live={activityLive}
          onOpenFile={onOpenFile}
          onOpenDesign={onOpenDesign}
          command={command}
        />
      )}
    </>
  );
}

function ActionButton({
  action,
  label,
  title,
  children,
}: {
  action: MessageAction;
  label: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="copy-button"
      disabled={'reason' in action}
      title={'reason' in action ? action.reason : title}
      onClick={'run' in action ? action.run : undefined}
    >
      {children} <span>{label}</span>
    </button>
  );
}

function UserComposerMessage({ text }: { text: string }) {
  const { t } = useDesktopText();
  const hunt = parseBugHuntMessage(text);
  if (hunt) return <HuntRoundCard round={hunt} />;
  const perf = parsePerfRunMessage(text);
  if (perf)
    return (
      <section className="hunt-round-card" aria-label={t('parityUi.performance')}>
        <strong>{PERF_RUN_MODE_LABELS[perf.mode]}</strong>
        <p>
          {perf.scope || t('parityUi.wholeProject')}
          {perf.metric ? ` · ${PERF_RUN_METRIC_LABELS[perf.metric]}` : ''}
        </p>
      </section>
    );
  const view = splitReferenceMessage(text);
  return (
    <>
      {view.text}
      {view.paths.length > 0 && (
        <section className="chat-file-references" aria-label={t('message.references')}>
          {view.references.map((ref) => (
            <code key={referenceKey(ref)}>{referenceLabel(ref)}</code>
          ))}
        </section>
      )}
    </>
  );
}
