import { FileText, CircleStop, Send, ShieldAlert, X } from 'lucide-react';
import type { PendingConfirm, SessionInfo } from './types.js';
import type { StatusNoticeProjection } from './lib/status-notice.js';
import { detectFileMention, fileBasename } from './lib/file-mention.js';
import type { FileMention } from './lib/file-mention.js';

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
  sendPrompt: () => void;
  abort: () => void;
  decideConfirm: (decision: 'yes' | 'no' | 'always') => void;
  selectFile: (path: string) => void;
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
  sendPrompt,
  abort,
  decideConfirm,
  selectFile,
}: ComposerProps) {
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
      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          sendPrompt();
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
                  onClick={() =>
                    setFileRefs((current) => current.filter((ref) => ref !== path))
                  }
                  aria-label={`Remove ${path}`}
                >
                  <X size={11} />
                </button>
              </span>
            ))}
          </fieldset>
        )}
        <textarea
          ref={textareaRef}
          aria-label="Message"
          value={draft}
          placeholder={
            connection === 'open'
              ? 'Tell WrongStack what to do…  @ file'
              : 'Waiting for connection…'
          }
          disabled={connection !== 'open'}
          onChange={(event) => {
            const value = event.target.value;
            setDraft(value);
            setFileMention(
              detectFileMention(value, event.target.selectionStart ?? value.length),
            );
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
              sendPrompt();
            }
          }}
        />
        {running ? (
          <button
            type="button"
            className="send-button stop"
            onClick={abort}
            aria-label="Stop run"
          >
            <CircleStop size={18} />
          </button>
        ) : (
          <button
            type="submit"
            className="send-button"
            disabled={(!draft.trim() && fileRefs.length === 0) || connection !== 'open'}
            aria-label="Send message"
          >
            <Send size={18} />
          </button>
        )}
      </form>
      <div className="composer-meta">
        <span
          className={notice ? `composer-notice ${notice.tone}` : undefined}
          aria-live="polite"
        >
          {notice?.text ?? '@ FILE · ENTER SEND · SHIFT+ENTER NEW LINE'}
        </span>
        <span>{session?.model ?? 'NO MODEL'}</span>
      </div>
    </div>
  );
}
