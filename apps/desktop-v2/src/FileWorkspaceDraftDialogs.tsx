import { DraftMergeChoices } from './DraftMergeChoices';
import { FileBulkDialog } from './FileBulkDialog';
import { fileErrorText } from './file-model';
import type { FileWorkspaceModel } from './file-workspace-model';
import { Modal } from './Modal';

export function FileWorkspaceDraftDialogs({ model }: { model: FileWorkspaceModel }) {
  const {
    t,
    documents,
    setDocuments,
    folder,
    busy,
    error,
    setNotice,
    draftStore,
    draftConflict,
    setDraftConflict,
    refreshDrafts,
    docs,
    all,
    reload,
    openFile,
    run,
    updateDocument,
    hasUnsaved,
    removePath,
    batchFiles,
    batchCopy,
    copyMany,
    moveMany,
    removeMany,
    movePath,
    copyPath,
    renamePath,
    picked,
    setPicked,
    bulk,
    setBulk,
  } = model;
  return (
    <>
      {bulk && (
        <FileBulkDialog
          kind={bulk}
          paths={picked}
          initialTarget={folder}
          isDirectory={(path) => all.find((node) => node.path === path)?.type === 'directory'}
          hasUnsaved={hasUnsaved}
          move={movePath}
          copy={copyPath}
          rename={renamePath}
          remove={removePath}
          moveMany={batchFiles ? moveMany : undefined}
          copyMany={batchCopy ? copyMany : undefined}
          removeMany={batchFiles ? removeMany : undefined}
          onClose={() => setBulk(null)}
          onFinished={(summary, changed) => {
            setBulk(null);
            setPicked((current) => current.filter((path) => !changed.includes(path)));
            setNotice(summary);
            void reload();
          }}
        />
      )}
      {draftConflict && (
        <Modal
          onClose={() => {
            if (!busy) setDraftConflict(null);
          }}
        >
          <div className="file-draft-comparison">
            <h2 id="dialog-title">{t('fileView.conflictTitle')}</h2>
            <p>
              <strong>{draftConflict.path}</strong>
            </p>
            <p>{t('fileView.conflictBody')}</p>
            <div className="file-draft-versions">
              <label>
                {t('fileView.yourEditor')}
                <textarea
                  aria-label={t('fileView.yourEditor')}
                  readOnly
                  value={documents[draftConflict.path]?.content ?? ''}
                />
              </label>
              <label>
                {t('fileView.storedDraft')}
                <textarea
                  aria-label={t('fileView.storedDraft')}
                  readOnly
                  value={draftConflict.snapshot.value?.content ?? t('fileView.noStoredDraft')}
                />
              </label>
            </div>
            {typeof draftConflict.snapshot.value?.content === 'string' && (
              <DraftMergeChoices
                key={draftConflict.snapshot.revision}
                mine={documents[draftConflict.path]?.content ?? ''}
                stored={draftConflict.snapshot.value.content}
                busy={busy}
                onKeep={(merged) =>
                  void run(async () => {
                    const { path, snapshot } = draftConflict;
                    const document = docs.current[path];
                    if (!document) return;
                    try {
                      await draftStore.resolve(path, snapshot.revision, merged, document.saved);
                    } catch (error) {
                      if (String(error).includes('DRAFT_CONFLICT'))
                        setDraftConflict({ path, snapshot: await draftStore.inspect(path) });
                      throw error;
                    }
                    updateDocument(path, { content: merged });
                    setDraftConflict(null);
                    await refreshDrafts();
                    setNotice(t('fileView.mergedStored'));
                  })
                }
              />
            )}
            {error && (
              <p role="alert" className="file-workspace-error">
                {fileErrorText(error, t)}
              </p>
            )}
            <footer>
              <button
                type="button"
                className="button secondary"
                onClick={() => setDraftConflict(null)}
              >
                {t('fileView.keepEditing')}
              </button>
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const { path, snapshot } = draftConflict;
                    const document = docs.current[path];
                    if (!document) return;
                    try {
                      await draftStore.resolve(
                        path,
                        snapshot.revision,
                        document.content,
                        document.saved,
                      );
                    } catch (error) {
                      if (String(error).includes('DRAFT_CONFLICT'))
                        setDraftConflict({ path, snapshot: await draftStore.inspect(path) });
                      throw error;
                    }
                    setDraftConflict(null);
                    await refreshDrafts();
                    setNotice(t('fileView.localStored'));
                  })
                }
              >
                {t('fileView.keepMine')}
              </button>
              <button
                type="button"
                className="button primary"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const { path, snapshot } = draftConflict;
                    const latest = await draftStore.inspect(path);
                    if (latest.revision !== snapshot.revision) {
                      setDraftConflict({ path, snapshot: latest });
                      throw Error(t('fileView.draftChangedAgain'));
                    }
                    draftStore.forget(path);
                    delete docs.current[path];
                    setDocuments({ ...docs.current });
                    setDraftConflict(null);
                    await openFile(path);
                  })
                }
              >
                {t('fileView.useStored')}
              </button>
            </footer>
          </div>
        </Modal>
      )}
    </>
  );
}
