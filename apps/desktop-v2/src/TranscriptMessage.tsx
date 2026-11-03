import { parseBugHuntMessage } from '@wrongstack/project-surfaces/lib/bug-hunt-message';
import { stripNextStepsBlock } from '@wrongstack/webui-protocol';
import { Code2, Pencil, RotateCcw } from 'lucide-react';
import { lazy, type ReactNode, Suspense, useState } from 'react';
import { AttachmentPreview } from './ComposerAttachments';
import { CopyButton } from './CopyButton';
import { referenceKey, referenceLabel, splitReferenceMessage } from './composer-resources-model';
import type { EngineState } from './engine-state';
import { HuntRoundCard } from './HuntRounds';
import { MarkdownContent } from './MarkdownContent';
import { TurnTools } from './TurnTools';
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
  edit,
  askAgain,
}: {
  message: Message;
  state: Pick<EngineState, 'turnActivity' | 'turnStats'>;
  onLink: (href: string) => void;
  onOpenFile: (path: string) => void;
  /** Puts this prompt into the composer. */
  edit?: MessageAction | undefined;
  /** Sends the prompt that produced this answer again. */
  askAgain?: MessageAction | undefined;
}) {
  const [source, setSource] = useState(false);
  const user = message.role === 'user';
  const answer = !user && !message.council;
  return (
    <article className={`chat-message ${message.role}`}>
      <header className={user ? 'user-chat-label' : undefined}>
        <span>{user ? 'You' : 'WrongStack'}</span>
        <span className="message-actions">
          {edit && (
            <ActionButton
              action={edit}
              label="Edit in composer"
              title="Put this prompt in the composer"
            >
              <Pencil size={12} />
            </ActionButton>
          )}
          {askAgain && (
            <ActionButton
              action={askAgain}
              label="Ask again"
              title="Send the prompt behind this answer again"
            >
              <RotateCcw size={12} />
            </ActionButton>
          )}
          {answer && (
            <button
              type="button"
              className="copy-button"
              aria-pressed={source}
              title={source ? 'Show the formatted answer' : 'Show the answer’s Markdown source'}
              onClick={() => setSource(!source)}
            >
              <Code2 size={12} /> <span>{source ? 'Formatted' : 'Source'}</span>
            </button>
          )}
          <CopyButton text={message.text} label="Copy message" />
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
      {(state.turnActivity[message.id] || state.turnStats[message.id]) && (
        <TurnTools
          events={state.turnActivity[message.id] ?? []}
          stats={state.turnStats[message.id]}
          onOpenFile={onOpenFile}
        />
      )}
    </article>
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
  const hunt = parseBugHuntMessage(text);
  if (hunt) return <HuntRoundCard round={hunt} />;
  const view = splitReferenceMessage(text);
  return (
    <>
      {view.text}
      {view.paths.length > 0 && (
        <section className="chat-file-references" aria-label="Referenced project files">
          {view.references.map((ref) => (
            <code key={referenceKey(ref)}>{referenceLabel(ref)}</code>
          ))}
        </section>
      )}
    </>
  );
}
