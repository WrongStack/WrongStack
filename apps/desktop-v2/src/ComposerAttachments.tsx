import { FileText, LoaderCircle, Paperclip, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  attachmentDataUrl,
  type ComposerAttachment,
  decodeAttachment,
  isPdf,
  processAttachmentFile,
  validateAttachments,
} from './composer-attachments';
import { Modal } from './Modal';
import './composer-attachments.css';

/** Writes an attachment's bytes through the window's download flow (PDFs cannot be shown inline). */
function saveAttachment(item: ComposerAttachment): void {
  const url = URL.createObjectURL(
    new Blob([decodeAttachment(item)], { type: item.mediaType || 'application/octet-stream' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = item.name || 'attachment.pdf';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function AttachmentPreview({
  items,
  interactive = true,
}: {
  items: readonly ComposerAttachment[];
  interactive?: boolean;
}) {
  const [selected, setSelected] = useState<ComposerAttachment | null>(null);
  return (
    <>
      <section className="message-attachments" aria-label="Message attachments">
        {items.map((item, i) =>
          isPdf(item) ? (
            <span className="attachment-document" key={i}>
              <FileText size={19} />
              <span>
                {item.name}
                <small>PDF · {(item.bytes / 1024).toFixed(0)} KB</small>
              </span>
              {interactive && item.data && (
                <button
                  type="button"
                  className="button secondary small"
                  aria-label={`Save ${item.name}`}
                  onClick={() => saveAttachment(item)}
                >
                  Save
                </button>
              )}
            </span>
          ) : !interactive ? (
            <div className="attachment-image" key={i}>
              <img src={attachmentDataUrl(item)} alt={item.name} loading="lazy" />
              <span>{item.name}</span>
            </div>
          ) : (
            <button
              key={i}
              type="button"
              className="attachment-image"
              aria-label={`Preview ${item.name}`}
              onClick={() => setSelected(item)}
            >
              <img src={attachmentDataUrl(item)} alt={item.name} loading="lazy" />
              <span>{item.name}</span>
            </button>
          ),
        )}
      </section>
      {selected && (
        <Modal onClose={() => setSelected(null)}>
          <div className="attachment-preview">
            <header>
              <h2 id="dialog-title">{selected.name}</h2>
              <button
                type="button"
                className="icon-button"
                aria-label="Close attachment preview"
                onClick={() => setSelected(null)}
              >
                <X size={18} />
              </button>
            </header>
            <img src={attachmentDataUrl(selected)} alt={selected.name} />
          </div>
        </Modal>
      )}
    </>
  );
}
export function useComposerAttachments(
  items: ComposerAttachment[],
  onChange: (items: ComposerAttachment[]) => void,
) {
  const [processing, setProcessing] = useState(false),
    [error, setError] = useState(''),
    [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null),
    current = useRef(items),
    alive = useRef(true),
    reading = useRef(false);
  current.current = items;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const add = async (files: File[]) => {
    if (!files.length || reading.current) return;
    reading.current = true;
    setProcessing(true);
    setError('');
    try {
      if (files.length + current.current.length > 12)
        throw Error('Attach up to 8 images and 4 PDFs.');
      const next: ComposerAttachment[] = [];
      for (const file of files) next.push(await processAttachmentFile(file));
      if (!alive.current) return;
      const merged = [...current.current, ...next];
      validateAttachments(merged);
      current.current = merged;
      onChange(merged);
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      reading.current = false;
      if (alive.current) setProcessing(false);
    }
  };
  return { processing, error, dragging, add, picker, setDragging };
}
export function ComposerAttachments({
  items,
  disabled,
  onChange,
  control,
}: {
  items: ComposerAttachment[];
  disabled: boolean;
  onChange: (items: ComposerAttachment[]) => void;
  control: ReturnType<typeof useComposerAttachments>;
}) {
  return (
    <>
      <input
        ref={control.picker}
        type="file"
        hidden
        multiple
        accept="image/*,application/pdf,.pdf"
        aria-label="Attachment files"
        disabled={disabled || control.processing}
        onChange={(e) => {
          void control.add(Array.from(e.currentTarget.files ?? []));
          e.currentTarget.value = '';
        }}
      />
      {control.processing && (
        <p className="composer-notice" role="status">
          <LoaderCircle className="spin" size={13} /> Preparing attachments…
        </p>
      )}
      {control.error && (
        <p role="alert" className="composer-error">
          {control.error}
        </p>
      )}
      {control.dragging && (
        <p className="attachment-drop-hint">
          <Paperclip size={14} /> Drop images or PDFs here
        </p>
      )}
      {items.length > 0 && (
        <section className="composer-attachment-tray" aria-label="Draft attachments">
          {items.map((item) => (
            <div key={item.id} className="draft-attachment">
              {isPdf(item) ? <FileText size={25} /> : <img src={attachmentDataUrl(item)} alt="" />}
              <span title={item.name}>
                {item.name}
                <small>
                  {isPdf(item) ? 'PDF' : 'Image'} · {(item.bytes / 1024).toFixed(0)} KB
                </small>
              </span>
              <button
                type="button"
                className="icon-button"
                aria-label={`Remove attachment ${item.name}`}
                disabled={disabled || control.processing}
                onClick={() => onChange(items.filter((a) => a.id !== item.id))}
              >
                <X size={13} />
              </button>
            </div>
          ))}
          <button
            type="button"
            disabled={disabled || control.processing}
            onClick={() => onChange([])}
          >
            Clear attachments
          </button>
        </section>
      )}
    </>
  );
}
