import {
  CircleStop,
  FileText,
  Image,
  ListPlus,
  Send,
  ShieldAlert,
  Waves,
  Split,
  X,
} from 'lucide-react';
import type { PendingConfirm, SessionInfo } from './types.js';
import type { StatusNoticeProjection } from './lib/status-notice.js';
import { detectFileMention, fileBasename } from './lib/file-mention.js';
import type { FileMention } from './lib/file-mention.js';
import type { QueueMode, QueuedItem } from './lib/queue-model.js';
import type { RefineDecision, RefineState } from './lib/refine-model.js';
import { QueuedMessages } from './queued-messages.js';
import { RefinePanel } from './refine-panel.js';

interface ComposerProps {
  draft: string;
  setDraft: (value: string) => void;
  fileRefs: string[];
  setFileRefs: (fn: (prev: string[]) => string[]) => void;
  fileMention: FileMention | null;
  setFileMention: (value: FileMention | null) => void;
  fileMatches: string[];
  filePickerIndex: number;
  setFilePickerIndex: (fn: (prev: number) => number) => void;
  fileSearching: boolean;
  running: boolean;
  connection: string;
  session: SessionInfo | null;
  pendingConfirm: PendingConfirm | null;
  notice: (StatusNoticeProjection & { id: string }) | null;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  queue: readonly QueuedItem[];
  refineState: RefineState | null;
  submitWith: (mode: QueueMode) => void;
  abort: () => void;
  decideConfirm: (decision: 'yes' | 'no' | 'always') => void;
  selectFile: (path: string) => void;
  clearQueue: () => void;
  removeQueued: (id: string) => void;
  onRefineDecision: (decision: RefineDecision) => void;
  onRefineRetry: () => void;
  onRefineRetryFallback: (ref: string) => void;
  onRefineStartNow: () => void;
  onRefineSendEdited: (text: string) => void;
  preRefineSeconds?: number;
  // Image attachment
  attachedImages: { id: string; data: string; mime: string; name: string }[];
  onAttachImages: () => void;
  onRemoveImage: (id: string) => void;
  visionSupported: boolean;
}

function safeLine(value: unknown): string {
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return text.length > 180 ? `${text.slice(0, 177)}…` : text;
  } catch {
    return 'Tool input';
  }
}

export function Composer({
  draft,
  setDraft,
  fileRefs,
  setFileRefs,
  fileMention,
  setFileMention,
  fileMatches,
  filePickerIndex,
  setFilePickerIndex,
  fileSearching,
  running,
  connection,
  session,
  pendingConfirm,
  notice,
  textareaRef,
  queue,
  refineState,
  submitWith,
  abort,
  decideConfirm,
  selectFile,
  clearQueue,
  removeQueued,
  onRefineDecision,
  onRefineRetry,
  onRefineRetryFallback,
  onRefineStartNow,
  onRefineSendEdited,
  preRefineSeconds,
  attachedImages,
  onAttachImages,
  onRemoveImage,
  visionSupported,
}: ComposerProps) {
  const empty = !draft.trim() && fileRefs.length === 0 && attachedImages.length === 0;
  const offline = connection !== 'open';
  // While the refine panel owns the text, the composer must not accept a
  // second submit for the same message.
  const locked = offline || refineState !== null;

  return (
    <div className="composer-inner">
      {pendingConfirm && (
        <div className={`permission-bar ${pendingConfirm.riskTier ?? 'standard'}`}>
          <ShieldAlert size={17} />
          <div className="permission-copy">
            <strong>Allow {pendingConfirm.toolName}?</strong>
            <span>{safeLine(pendingConfirm.input)}</span>
          </div>
          <div className="permission-actions">
            <button type="button" onClick={() => decideConfirm('no')}>
              Deny
            </button>
            <button type="button" onClick={() => decideConfirm('always')}>
              Always
            </button>
            <button type="button" className="primary" onClick={() => decideConfirm('yes')}>
              Allow
            </button>
          </div>
        </div>
      )}

      {refineState && (
        <RefinePanel
          state={refineState}
          onDecision={onRefineDecision}
          onRetry={onRefineRetry}
          onRetryFallback={onRefineRetryFallback}
          onStartRefine={onRefineStartNow}
          onSendEdited={onRefineSendEdited}
          preRefineSeconds={preRefineSeconds}
        />
      )}

      <QueuedMessages queue={queue} onClear={clearQueue} onRemove={removeQueued} />

      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          submitWith('btw');
        }}
      >
        {fileMention && (
          <div className="file-picker" role="listbox" aria-label="Project files">
            <div className="file-picker-heading">
              <span>PROJECT FILES{fileMention.query && ` · ${fileMention.query}`}</span>
              <span>↑↓ · ENTER</span>
            </div>
            <div className="file-picker-list">
              {fileSearching && fileMatches.length === 0 ? (
                <div className="file-picker-empty">Searching…</div>
              ) : fileMatches.length === 0 ? (
                <div className="file-picker-empty">No matching files</div>
              ) : (
                fileMatches.map((path, index) => (
                  <button
                    type="button"
                    role="option"
                    aria-selected={index === filePickerIndex}
                    className={index === filePickerIndex ? 'active' : undefined}
                    key={path}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => setFilePickerIndex(() => index)}
                    onClick={() => selectFile(path)}
                  >
                    <FileText size={13} aria-hidden="true" />
                    <span>{path}</span>
                  </button>
                ))
              )}
            </div>
          </div>
        )}
        {fileRefs.length > 0 && (
          <fieldset className="file-references" aria-label="Referenced files">
            {fileRefs.map((path) => (
              <span className="file-reference" key={path} title={path}>
                <FileText size={12} aria-hidden="true" />
                <span>{fileBasename(path)}</span>
                <button
                  type="button"
                  onClick={() => setFileRefs((current) => current.filter((ref) => ref !== path))}
                  aria-label={`Remove ${path}`}
                >
                  <X size={11} />
                </button>
              </span>
            ))}
          </fieldset>
        )}
        {attachedImages.length > 0 && (
          <fieldset className="file-references" aria-label="Attached images">
            {attachedImages.map((img) => (
              <span className="file-reference" key={img.id} title={img.name}>
                <Image size={12} aria-hidden="true" />
                <span>{img.name}</span>
                <button
                  type="button"
                  onClick={() => onRemoveImage(img.id)}
                  aria-label={`Remove ${img.name}`}
                >
                  <X size={11} />
                </button>
              </span>
            ))}
          </fieldset>
        )}
        {/\[VIBE\]/i.test(draft) && (
          <div className="vibe-mode-pill" role="status">
            <Waves size={12} aria-hidden="true" />
            <span>
              <strong>VIBE Protocol:</strong> Three-Stage Verification (Spec → Coder → Auditor)
            </span>
          </div>
        )}
        <textarea
          ref={textareaRef}
          aria-label="Message"
          value={draft}
          placeholder={
            offline
              ? 'Waiting for connection…'
              : running
                ? 'Add to the run…  ENTER rides alongside · @ file'
                : 'Tell WrongStack what to do…  @ file'
          }
          disabled={locked}
          onChange={(event) => {
            const value = event.target.value;
            setDraft(value);
            setFileMention(detectFileMention(value, event.target.selectionStart ?? value.length));
          }}
          onSelect={(event) => {
            const textarea = event.currentTarget;
            setFileMention(detectFileMention(textarea.value, textarea.selectionStart));
          }}
          onKeyDown={(event) => {
            if (fileMention) {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setFilePickerIndex((current) =>
                  fileMatches.length > 0 ? (current + 1) % fileMatches.length : 0,
                );
                return;
              }
              if (event.key === 'ArrowUp') {
                event.preventDefault();
                setFilePickerIndex((current) =>
                  fileMatches.length > 0
                    ? (current - 1 + fileMatches.length) % fileMatches.length
                    : 0,
                );
                return;
              }
              if ((event.key === 'Enter' || event.key === 'Tab') && fileMatches.length > 0) {
                event.preventDefault();
                const path = fileMatches[filePickerIndex];
                if (path) selectFile(path);
                return;
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                setFileMention(null);
                return;
              }
            }
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              // Enter is the softest send: it never interrupts a run.
              // Steering is an explicit, separate button.
              submitWith(event.ctrlKey || event.metaKey ? 'queue' : 'btw');
            }
          }}
        />
        <div className="composer-actions">
          <button
            type="button"
            className="image-attach-button"
            title={visionSupported ? 'Attach images' : 'Current model does not support vision'}
            aria-label="Attach images"
            disabled={offline || !visionSupported}
            onClick={onAttachImages}
          >
            <Image size={17} />
          </button>
          {/* Stop stays reachable while a run is in flight even with a draft
              typed — aborting and sending are independent intents. */}
          {running && (
            <button
              type="button"
              className="mode-button stop"
              onClick={abort}
              title="Stop the run"
              aria-label="Stop run"
            >
              <CircleStop size={15} />
            </button>
          )}
          {running && (
            <button
              type="button"
              className="mode-button steer"
              onClick={() => submitWith('steer')}
              disabled={locked || empty}
              title="Interrupt the run and send this instead"
              aria-label="Steer the run with this message"
            >
              <Split size={15} />
            </button>
          )}
          <button
            type="button"
            className="mode-button queue"
            onClick={() => submitWith('queue')}
            disabled={locked || empty}
            title="Hold this until the current run finishes"
            aria-label="Add message to queue"
          >
            <ListPlus size={15} />
          </button>
          <button
            type="submit"
            className="send-button"
            disabled={empty || locked}
            title={running ? 'Send alongside the run' : 'Send'}
            aria-label={running ? 'Send message alongside the run' : 'Send message'}
          >
            <Send size={18} />
          </button>
        </div>
      </form>
      <div className="composer-meta">
        <span className={notice ? `composer-notice ${notice.tone}` : undefined} aria-live="polite">
          {notice?.text ??
            (running
              ? '@ FILE · ENTER ADDS TO RUN · CTRL+ENTER QUEUES'
              : '@ FILE · ENTER SEND · SHIFT+ENTER NEW LINE')}
        </span>
        <span>{session?.model ?? 'NO MODEL'}</span>
      </div>
    </div>
  );
}
