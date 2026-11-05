import { parseBugHuntMessage } from '@wrongstack/project-surfaces/lib/bug-hunt-message';
import { stripNextStepsBlock } from '@wrongstack/webui-protocol';
import { Code2, Pencil, RotateCcw } from 'lucide-react';
import { lazy, type ReactNode, Suspense, useState } from 'react';
import { AttachmentPreview } from './ComposerAttachments';
import { CopyButton } from './CopyButton';
import { referenceKey, referenceLabel, splitReferenceMessage } from './composer-resources-model';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand } from './engine-operations';
import type { EngineState } from './engine-state';
import { HuntRoundCard } from './HuntRounds';
import { MarkdownContent } from './MarkdownContent';
import { LiveRunActivity, TurnTools } from './TurnTools';
import './transcript-message.css';

const CouncilCard = lazy(() => import('./CouncilCard'));

type Message = EngineState['messages'][number];

/** An action on a message: enabled with `run`, or shown disabled with the reason. */
export type MessageAction = { run: () => void } | { reason: string };

/**
 * One message of the conversation with its actions: copy; a prompt can be taken back into the
 * composer; the latest answer can be asked again; an answer can show its Markdown source.
 */
export function TranscriptMessage({
  message,
  state,
  onLink,
  onOpenFile,
  command,
  edit,
  askAgain,
  mark,
  day,
  activityLive = false,
}: {
  message: Message;
  state: Pick<EngineState, 'turnActivity' | 'turnStats'>;
  onLink: (href: string) => void;
  onOpenFile: (path: string) => void;
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
}) {
  const { t } = useDesktopText();
  const [source, setSource] = useState(false);
  const user = message.role === 'user';
  const answer = !user && !message.council;
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
          {message.council ? (
            <Suspense fallback={<MarkdownContent text={message.text} onLink={onLink} />}>
              <CouncilCard decision={message.council} />
            </Suspense>
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
            events={[]}
            stats={state.turnStats[message.id]}
            onOpenFile={onOpenFile}
            command={command}
          />
        )}
      </article>
      {!!message.activityAfter?.length && (
        <LiveRunActivity
          events={message.activityAfter}
          live={activityLive}
          onOpenFile={onOpenFile}
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
