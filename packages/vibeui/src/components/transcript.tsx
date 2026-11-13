'use client';

import { Brain, Check, Copy, Pencil, Sparkles } from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';
import type { ChatEntry, SessionState } from '../lib/session';
import { groupTranscript } from '../lib/transcript-view';
import type { SessionController } from '../lib/use-session';
import { autoSubmitAllowed } from '../lib/workspace-derived';
import { AssistantContent } from './assistant-content';
import { ContentView } from './content-view';
import { MarkdownContent } from './markdown-content';
import { VibeMark } from './vibe-visuals';
import { WorkingActivity } from './working-activity';
import { WorkspaceNotes } from './workspace-notes';

/**
 * The grouped chat transcript (`groupTranscript`) plus the in-run working
 * activity strip. Pure projection — all state stays owned by `Workspace`.
 */
export function Transcript({
  state,
  controller,
  connection,
  ready,
  locked,
  presentation,
  compact,
  latestAssistantId,
  hasDraft,
  copied,
  copy,
  setInspectedToolId,
  showActivity,
}: {
  state: Pick<SessionState, 'messages' | 'prefs' | 'running' | 'runFailure' | 'tools'>;
  controller: SessionController;
  connection: SessionController['connection'];
  ready: boolean;
  locked: boolean;
  presentation: 'simple' | 'extended';
  compact: boolean;
  latestAssistantId: string | undefined;
  hasDraft: boolean;
  copied: string;
  copy: (id: string, value: string) => void;
  setInspectedToolId: Dispatch<SetStateAction<string>>;
  showActivity: () => void;
}) {
  return (
    <div className="transcript">
      {groupTranscript(
        state.messages.filter(
          (message) => message.role !== 'thinking' || state.prefs.showModelReasoning !== false,
        ),
      ).map((row) => {
        if (row.kind === 'workspace') return <WorkspaceNotes key={row.id} notes={row.notes} />;
        return (
          <MessageArticle
            key={row.message.id}
            message={row.message}
            controller={controller}
            connection={connection}
            ready={ready}
            locked={locked}
            presentation={presentation}
            latestAssistantId={latestAssistantId}
            hasDraft={hasDraft}
            copied={copied}
            copy={copy}
            running={state.running}
            runFailure={state.runFailure}
            prefs={state.prefs}
          />
        );
      })}
      {state.running && (
        <WorkingActivity
          compact={compact}
          tools={state.tools}
          onInspect={setInspectedToolId}
          onViewActivity={showActivity}
        />
      )}
    </div>
  );
}

/** One chat entry in the transcript: heading, attachments, body and runtime notes. */
function MessageArticle({
  message,
  controller,
  connection,
  ready,
  locked,
  presentation,
  latestAssistantId,
  hasDraft,
  copied,
  copy,
  running,
  runFailure,
  prefs,
}: {
  message: ChatEntry;
  controller: SessionController;
  connection: SessionController['connection'];
  ready: boolean;
  locked: boolean;
  presentation: 'simple' | 'extended';
  latestAssistantId: string | undefined;
  hasDraft: boolean;
  copied: string;
  copy: (id: string, value: string) => void;
  running: boolean;
  runFailure: SessionState['runFailure'];
  prefs: SessionState['prefs'];
}) {
  return (
    <article className={`message message-${message.role}`} id={`chat-${message.id}`} tabIndex={-1}>
      <div className="message-heading">
        <span className={`message-avatar ${message.role} ${message.streaming ? 'is-writing' : ''}`}>
          {message.role === 'user' ? (
            'Y'
          ) : message.role === 'assistant' ? (
            <VibeMark />
          ) : message.role === 'system' ? (
            '·'
          ) : (
            <Sparkles size={13} />
          )}
        </span>
        <strong>
          {message.role === 'user'
            ? 'You'
            : message.role === 'assistant'
              ? 'WrongStack'
              : message.role === 'thinking'
                ? 'Thinking'
                : 'Workspace'}
        </strong>
        {message.delivery === 'btw' && (
          <small className="streaming-label">BTW · sent during this run</small>
        )}
        {message.streaming && (
          <span className="streaming-label">
            writing<span>…</span>
          </span>
        )}
        {message.role === 'assistant' && !message.streaming && (
          <button
            type="button"
            className="icon-button copy-message"
            aria-label="Copy response"
            title={copied === message.id ? 'Copied' : 'Copy response'}
            onClick={() => void copy(message.id, message.text)}
          >
            {copied === message.id ? <Check size={13} /> : <Copy size={13} />}
          </button>
        )}
        {message.role === 'user' && (
          <button
            type="button"
            className="icon-button copy-message"
            aria-label="Restore message to composer"
            title="Restore to composer"
            onClick={() =>
              controller.prepareDraft(
                message.text,
                (message.images ?? []).map((image, i) => ({
                  ...image,
                  id: `${message.id}-${i}`,
                  name: `Attachment ${i + 1}`,
                })),
              )
            }
          >
            <Pencil size={13} />
          </button>
        )}
      </div>
      {message.images && message.images.length > 0 && (
        <div className="chat-images">
          {message.images
            .filter((image) =>
              ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(image.mediaType),
            )
            .map((image, i) => (
              <img
                key={i}
                src={`data:${image.mediaType};base64,${image.data}`}
                alt={`Attachment ${i + 1}`}
              />
            ))}
        </div>
      )}
      {message.role === 'thinking' ? (
        <details className="thinking-block">
          <summary>
            <Brain size={13} />
            {message.streaming ? 'Thinking…' : 'Thinking / reasoning'}
          </summary>
          <MarkdownContent text={message.text} />
        </details>
      ) : message.role === 'assistant' ? (
        <AssistantContent
          text={message.text}
          showSteps={
            !running && !runFailure && message.final === true && message.id === latestAssistantId
          }
          onPick={controller.prepareDraft}
          onSubmit={(value, automatic) => controller.submitNext(value, message.id, automatic)}
          automatic={autoSubmitAllowed({
            prefs,
            autoEligible: message.autoEligible,
            hasDraft,
            queued: controller.queue.length,
            autoLimitReached: controller.autoLimitReached,
            connection,
            ready,
            locked,
          })}
          autoDelayMs={Number(prefs.autonomyDelayMs) || 15000}
        />
      ) : message.text === 'Runtime context' && message.runtimeContext?.length ? null : (
        <MarkdownContent text={message.text} />
      )}
      {message.runtimeContext && (
        <details className="runtime-context" key={presentation} open={presentation === 'extended'}>
          <summary>
            Runtime context · {message.runtimeContext.length}{' '}
            {message.runtimeContext.length === 1 ? 'note' : 'notes'} added by WrongStack
          </summary>
          {message.runtimeContext.map((note, index) => (
            <ContentView key={index} value={note} label="Runtime context" />
          ))}
        </details>
      )}
    </article>
  );
}
