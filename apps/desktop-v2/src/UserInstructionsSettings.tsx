import { BookOpen, Check, Eye, FilePenLine, RefreshCw, Save } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand } from './engine-operations';
import { MarkdownContent } from './MarkdownContent';

type Row = Record<string, unknown>;
export interface InstructionDraft {
  document: Row | null;
  text: string;
}
export function UserInstructionsSettings({
  command,
  value,
  onChange,
}: {
  command: EngineCommand;
  value: InstructionDraft;
  onChange: (next: InstructionDraft) => void;
}) {
  const { t } = useDesktopText();
  const current = useRef(value);
  current.current = value;
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [preview, setPreview] = useState(false),
    [confirmReload, setConfirmReload] = useState(false);
  const dirty = value.document !== null && value.text !== String(value.document['text'] ?? '');
  useEffect(() => {
    let active = true;
    setBusy(true);
    void command('user_instructions.get', {}, ['user_instructions'])
      .then((doc) => {
        if (!active) return;
        const draft = current.current;
        if (!draft.document || draft.text === String(draft.document['text'] ?? ''))
          onChange({ document: doc, text: String(doc['text'] ?? '') });
        else if (doc['mtimeMs'] !== draft.document['mtimeMs'])
          setNotice(t('userInstructions.changedElsewhere'));
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [command, onChange, t]);
  const reload = async () => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const doc = await command('user_instructions.get', {}, ['user_instructions']);
      onChange({ document: doc, text: String(doc['text'] ?? '') });
      setConfirmReload(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    if (!value.document) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await command(
        'user_instructions.save',
        { text: value.text, baseMtimeMs: value.document['mtimeMs'] ?? null },
        ['user_instructions'],
      );
      const doc = await command('user_instructions.get', {}, ['user_instructions']);
      if (doc['text'] !== value.text) throw Error(t('userInstructions.changedAgain'));
      onChange({ document: doc, text: String(doc['text'] ?? '') });
      setNotice(t('userInstructions.saved'));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="instructions-settings" aria-label={t('userInstructions.label')}>
      <header className="settings-section-heading">
        <div>
          <span className="eyebrow">{t('userInstructions.eyebrow')}</span>
          <h2>{t('userInstructions.title')}</h2>
          <p>{t('userInstructions.intro')}</p>
        </div>
        <BookOpen size={25} />
      </header>
      <div className="instruction-file-meta">
        <code>{String(value.document?.['displayPath'] ?? t('userInstructions.fileName'))}</code>
        <span>
          {value.document?.['exists'] === false
            ? t('userInstructions.noFile')
            : value.document
              ? t('userInstructions.userOwned')
              : t('userInstructions.loadingDoc')}
        </span>
      </div>
      {error && (
        <p className="session-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="studio-notice" role="status">
          <Check size={14} />
          {notice}
        </p>
      )}
      <div className="instruction-editor-toolbar">
        <fieldset className="view-segment" aria-label={t('userInstructions.view')}>
          <button type="button" aria-pressed={!preview} onClick={() => setPreview(false)}>
            <FilePenLine size={14} />
            {t('userInstructions.edit')}
          </button>
          <button type="button" aria-pressed={preview} onClick={() => setPreview(true)}>
            <Eye size={14} />
            {t('userInstructions.preview')}
          </button>
        </fieldset>
        <span>
          {t('userInstructions.counts', {
            chars: value.text.length.toLocaleString(),
            lines: value.text ? value.text.split('\n').length : 0,
          })}
          {dirty ? ` · ${t('userInstructions.unsaved')}` : ''}
        </span>
      </div>
      {preview ? (
        <section className="instruction-preview" aria-label={t('userInstructions.previewLabel')}>
          <MarkdownContent text={value.text || t('userInstructions.empty')} />
        </section>
      ) : (
        <textarea
          className="instruction-editor"
          aria-label={t('userInstructions.textLabel')}
          spellCheck={false}
          disabled={busy || !value.document}
          value={value.text}
          onChange={(e) => {
            onChange({ ...value, text: e.target.value });
            setNotice('');
          }}
          placeholder={t('userInstructions.placeholder')}
        />
      )}
      <p className="field-help">{t('userInstructions.emptyNote')}</p>
      {confirmReload && (
        <div className="instruction-reload-confirm" role="alert">
          <p>{t('userInstructions.reloadQuestion')}</p>
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={() => void reload()}
          >
            {t('userInstructions.discard')}
          </button>
          <button
            type="button"
            className="button secondary"
            onClick={() => setConfirmReload(false)}
          >
            {t('userInstructions.keepEditing')}
          </button>
        </div>
      )}
      <footer className="settings-save-bar">
        <span>
          {dirty ? t('userInstructions.unsavedChanges') : t('userInstructions.savedLoaded')}
        </span>
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={() => (dirty ? setConfirmReload(true) : void reload())}
        >
          <RefreshCw size={14} />
          {t('userInstructions.reload')}
        </button>
        <button
          type="button"
          className="button primary"
          disabled={busy || !dirty}
          onClick={() => void save()}
        >
          <Save size={14} />
          {busy ? t('userInstructions.working') : t('userInstructions.save')}
        </button>
      </footer>
    </section>
  );
}
