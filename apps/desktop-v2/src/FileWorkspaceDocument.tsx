import {
  File,
  FileCode2,
  FileDiff,
  FilePlus2,
  LoaderCircle,
  MoreHorizontal,
  Pencil,
  Quote,
  Save,
  X,
} from 'lucide-react';
import { CodeEditorSlot, rememberPlainEditor } from './CodeEditorSlot';
import { BinaryChange, DiffPreview } from './DiffPreview';
import { EditorFindBar } from './EditorFindBar';
import { replacementRange } from './editor-indent';
import { codeEditorEdit } from './editor-language';
import { FileEvidenceDrawer } from './FileEvidenceDrawer';
import { FileExplorerTab } from './FileExplorerChrome';
import { fileKind, fileName } from './file-model';
import type { FileWorkspaceModel } from './file-workspace-model';
import { ViewerFindBar } from './ViewerFindBar';

export function FileWorkspaceDocument({ model }: { model: FileWorkspaceModel }) {
  const {
    command,
    mode,
    onReference,
    send,
    state,
    t,
    documents,
    active,
    setActive,
    loading,
    busy,
    plainEditor,
    setPlainEditor,
    setError,
    setNotice,
    diff,
    setAction,
    setValue,
    setHunkReview,
    setMergeReview,
    setMenu,
    contentElement,
    searchSelection,
    all,
    reload,
    refreshDiff,
    run,
    updateDocument,
    save,
    close,
    stage,
    document,
    isDirty,
    change,
    finding,
    setFinding,
    pendingSelection,
    viewerFind,
    closeViewerFind,
    updateViewerFind,
    referenceSelection,
  } = model;
  return (
    <>
      <nav className="file-open-tabs" aria-label={t('fileView.openTabs')}>
        {/* Review has no folder listing: its empty state asks for a change instead. */}
        {mode === 'files' && <FileExplorerTab selected={!active} onSelect={() => setActive('')} />}
        {Object.entries(documents).map(([path, doc]) => (
          <div className={active === path ? 'file-tab-current' : ''} key={path}>
            <button
              type="button"
              aria-label={t('fileView.openTab', { path })}
              title={path}
              onClick={() => setActive(path)}
            >
              <FileCode2 size={13} />
              {fileName(path)}
              {doc.content !== doc.saved && <span className="file-unsaved-dot" />}
            </button>
            <button
              type="button"
              aria-label={t('fileView.closeTab', { path })}
              onClick={() => close(path)}
            >
              <X size={12} />
            </button>
          </div>
        ))}
        {active && !documents[active] && (
          <div className="file-tab-current">
            <button
              type="button"
              aria-label={t('fileView.openTab', { path: active })}
              title={active}
              onClick={() => setActive(active)}
            >
              <FileDiff size={13} />
              {fileName(active)}
            </button>
            <button
              type="button"
              aria-label={t('fileView.closeTab', { path: active })}
              onClick={() => setActive('')}
            >
              <X size={12} />
            </button>
          </div>
        )}
      </nav>
      {active ? (
        <>
          <div className="file-document-toolbar">
            <span className="file-document-path" title={active}>
              {active}
            </span>
            <span className="file-document-language">{fileKind(t, active)}</span>
            {document && !document.binary && !document.tooLarge && mode === 'files' && (
              <button
                type="button"
                aria-pressed={document.editing}
                onClick={() => updateDocument(active, { editing: !document.editing })}
              >
                <Pencil size={13} />
                {document.editing ? t('fileView.readView') : t('fileView.editFile')}
              </button>
            )}
            {document?.editing && mode === 'files' && (
              <button
                type="button"
                aria-pressed={plainEditor}
                onClick={() => setPlainEditor(rememberPlainEditor(!plainEditor))}
              >
                {t('fileView.plainEditor')}
              </button>
            )}
            {change && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void stage(active, Boolean(change['staged']))}
              >
                {change['staged'] ? t('fileView.unstage') : t('fileView.stage')}
              </button>
            )}
            {mode === 'files' && onReference && document && !document.binary && (
              <button
                type="button"
                className="button secondary small"
                title={t('fileView.referenceTitle')}
                // Keep the current text selection while the button is pressed.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => referenceSelection(false)}
              >
                <FilePlus2 size={13} />
                {t('fileView.reference')}
              </button>
            )}
            {mode === 'files' && onReference && document && !document.binary && (
              <button
                type="button"
                className="button secondary small"
                title={t('fileView.quoteTitle')}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => referenceSelection(true)}
              >
                <Quote size={13} />
                {t('fileView.quote')}
              </button>
            )}
            {mode === 'files' && (
              <button
                type="button"
                className="file-save-button"
                disabled={!isDirty || busy}
                onClick={() => void run(() => save(active))}
              >
                <Save size={13} />
                {busy ? t('fileView.saving') : t('fileView.save')}
              </button>
            )}
            <button
              type="button"
              className="icon-button"
              aria-label={t('fileView.actions')}
              onClick={(event) => {
                const anchor = event.currentTarget.getBoundingClientRect();
                setMenu({
                  path: active,
                  x: anchor.left,
                  y: anchor.bottom,
                });
              }}
            >
              <MoreHorizontal size={16} />
            </button>
          </div>
          <div className="file-document native-file-content" ref={contentElement}>
            {mode === 'changes' && change?.['status'] === 'U' && (
              <button
                type="button"
                className="button secondary"
                onClick={() => setMergeReview(true)}
              >
                {t('fileView.resolveConflict')}
              </button>
            )}
            {loading === active && !document ? (
              <div className="file-quiet-state">
                <LoaderCircle size={20} className="spin" />
                {t('fileView.readingFile', { name: fileName(active) })}
              </div>
            ) : mode === 'changes' ? (
              diff?.['error'] ? (
                <p className="file-quiet-state">{String(diff['error'])}</p>
              ) : diff?.['binary'] || diff?.['tooLarge'] ? (
                <BinaryChange diff={diff} path={active} />
              ) : diff ? (
                <>
                  {change?.['status'] !== 'U' && (
                    <button
                      type="button"
                      className="button secondary small file-hunk-review"
                      disabled={busy}
                      onClick={() => setHunkReview(true)}
                    >
                      {t('fileView.reviewHunks')}
                    </button>
                  )}
                  <DiffPreview
                    before={String(diff['oldText'] ?? '')}
                    after={String(diff['newText'] ?? '')}
                    path={active}
                    onComment={(line) => {
                      setAction({ kind: 'comment', path: active, line });
                      setValue('');
                    }}
                    edit={
                      change?.['status'] === 'D'
                        ? undefined
                        : {
                            command,
                            // Reloading may outlive the workspace (detached); say why, never throw.
                            onApplied: () =>
                              void reload()
                                .then(refreshDiff)
                                .catch((e: unknown) =>
                                  setError(String(e instanceof Error ? e.message : e)),
                                ),
                          }
                    }
                  />
                </>
              ) : (
                <p className="file-quiet-state">{t('shellText.readingChanges')}</p>
              )
            ) : document?.image ? (
              <div className="file-image-preview">
                <img src={document.image} alt={fileName(active)} />
                <span>{fileName(active)}</span>
              </div>
            ) : document?.binary || document?.tooLarge ? (
              <div className="file-quiet-state">
                <File size={32} />
                <h3>{document.binary ? t('fileView.binary') : t('fileView.tooLarge')}</h3>
                <p>{t('fileView.staysOnDisk')}</p>
              </div>
            ) : document?.editing && !plainEditor ? (
              <CodeEditorSlot
                path={active}
                value={document.content}
                label={t('fileView.editLabel', { path: active })}
                command={command}
                loading={t('fileView.loadingEditor')}
                onChange={(text) => updateDocument(active, { content: text })}
                onUnavailable={() => {
                  setPlainEditor(true);
                  setNotice(t('fileView.editorUnavailable'));
                }}
              />
            ) : document?.editing ? (
              <>
                {finding && (
                  <EditorFindBar
                    content={document.content}
                    editor={() =>
                      contentElement.current?.querySelector<HTMLTextAreaElement>(
                        'textarea.file-code-editor',
                      ) ?? null
                    }
                    onChange={(text, select) => {
                      updateDocument(active, { content: text });
                      if (select)
                        requestAnimationFrame(() =>
                          contentElement.current
                            ?.querySelector<HTMLTextAreaElement>('textarea.file-code-editor')
                            ?.setSelectionRange(select.start, select.end),
                        );
                    }}
                    onClose={() => setFinding(false)}
                  />
                )}
                <textarea
                  className="file-code-editor"
                  aria-label={t('fileView.editLabel', { path: active })}
                  spellCheck={false}
                  value={document.content}
                  onChange={(event) => updateDocument(active, { content: event.target.value })}
                  onKeyDown={(event) => {
                    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
                      event.preventDefault();
                      setFinding(true);
                      return;
                    }
                    const edit = codeEditorEdit(event, document.content, active);
                    if (edit?.text === document.content) {
                      // Typing over a closing character only moves the caret.
                      event.preventDefault();
                      event.currentTarget.setSelectionRange(edit.start, edit.end);
                    } else if (edit) {
                      event.preventDefault();
                      pendingSelection.current = { start: edit.start, end: edit.end };
                      // insertText keeps the edit in the textarea's own undo history; the
                      // input event it fires updates the draft like typing does.
                      const input = event.currentTarget;
                      const change = replacementRange(document.content, edit.text);
                      input.setSelectionRange(change.from, change.to);
                      if (!window.document.execCommand('insertText', false, change.insert))
                        updateDocument(active, { content: edit.text });
                    }
                  }}
                />
              </>
            ) : document ? (
              <>
                {viewerFind && (
                  <ViewerFindBar
                    key={active}
                    content={document.content}
                    onChange={updateViewerFind}
                    onClose={closeViewerFind}
                  />
                )}
                <section
                  className="file-source-code"
                  aria-label={t('fileView.sourceLabel', { path: active })}
                  // biome-ignore lint/a11y/noNoninteractiveTabindex: the source view takes Ctrl/Cmd+F.
                  tabIndex={0}
                >
                  {document.content.split('\n').map((line, index) => (
                    <div
                      className={`file-source-line${searchSelection?.path === active && index + 1 >= searchSelection.line && index + 1 <= (searchSelection.endLine ?? searchSelection.line) ? ' search-match' : ''}${viewerFind?.lines.includes(index + 1) ? ' find-match' : ''}${viewerFind?.current === index + 1 ? ' find-current' : ''}`}
                      data-source-line={index + 1}
                      key={index}
                    >
                      <span aria-hidden="true">{index + 1}</span>
                      <code>
                        <HighlightLine text={line} />
                      </code>
                    </div>
                  ))}
                </section>
              </>
            ) : (
              <p className="file-quiet-state">{t('fileView.retry')}</p>
            )}
          </div>
          {document && mode === 'files' && (
            <FileEvidenceDrawer
              key={active}
              path={active}
              content={document.content}
              saved={document.saved}
              {...(all.find((n) => n.path === active)?.size !== undefined
                ? { size: all.find((n) => n.path === active)!.size }
                : {})}
              command={command}
              send={send}
              state={state}
              diff={diff}
              refreshDiff={refreshDiff}
            />
          )}
        </>
      ) : null}
    </>
  );
}

function HighlightLine({ text }: { text: string }) {
  return (
    <>
      {text
        .split(
          /(\/\/.*$|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`|\b(?:export|import|from|const|let|var|function|return|if|else|async|await|class|type|interface|true|false|null|undefined|new|throw|try|catch|public|private|def|fn|use|pub|impl|struct)\b|\b\d+(?:\.\d+)?\b)/g,
        )
        .map((token, index) => (
          <span
            key={index}
            className={
              token.startsWith('//')
                ? 'code-comment'
                : /^["'`]/.test(token)
                  ? 'code-string'
                  : /^\d/.test(token)
                    ? 'code-number'
                    : /^(export|import|from|const|let|var|function|return|if|else|async|await|class|type|interface|true|false|null|undefined|new|throw|try|catch|public|private|def|fn|use|pub|impl|struct)$/.test(
                          token,
                        )
                      ? 'code-keyword'
                      : undefined
            }
          >
            {token}
          </span>
        ))}
    </>
  );
}
