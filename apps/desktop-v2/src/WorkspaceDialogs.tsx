import { ArrowUpRight, LoaderCircle, Plus, ShieldCheck, Terminal, Workflow, X } from 'lucide-react';
import { useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import { Modal } from './Modal';
import { openPreview } from './platform';

import type { DesktopController } from './useDesktop';
import { WorkspacePalette } from './WorkspacePalette';
import './workspace-dialogs.css';

export function WorkspaceDialogs({ vm }: { vm: DesktopController }) {
  const { t } = useDesktopText();
  const {
    snapshot,
    dialog,
    setDialog,
    pending,
    sessionProject,
    setSessionProject,
    kind,
    setKind,
    title,
    setTitle,
    workdir,
    setWorkdir,
    preview,
    setPreview,
    run,
    createSession,
  } = vm;
  const [previewDevtools, setPreviewDevtools] = useState(false);
  if (dialog === 'palette') return <WorkspacePalette vm={vm} />;
  return (
    <>
      {' '}
      {dialog && (
        <Modal
          onClose={() => setDialog(null)}
          className={dialog === 'session' ? 'new-session-dialog' : undefined}
        >
          <header>
            <div>
              {dialog !== 'session' && (
                <span className="eyebrow">{t('workspaceDialog.eyebrow')}</span>
              )}
              <h2 id="dialog-title">
                {dialog === 'session' ? t('topbar.newSession') : t('workspaceDialog.title.preview')}
              </h2>
            </div>
            <button
              type="button"
              className="icon-button"
              title={t('workspaceDialog.close')}
              onClick={() => setDialog(null)}
            >
              <X size={19} />
            </button>
          </header>
          {dialog === 'session' && (
            <form
              className="new-session-form"
              onSubmit={(e) => {
                e.preventDefault();
                void createSession();
              }}
            >
              <div className="new-session-fields">
                <label>
                  {t('workspaceDialog.project')}
                  <select
                    required
                    value={sessionProject}
                    onChange={(e) => setSessionProject(e.target.value)}
                  >
                    {snapshot.projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="kind-picker">
                  <button
                    type="button"
                    aria-pressed={kind === 'agent'}
                    className={kind === 'agent' ? 'picked' : ''}
                    onClick={() => setKind('agent')}
                  >
                    <Workflow size={20} />
                    <strong>{t('workspaceDialog.agent')}</strong>
                    <span>{t('workspaceDialog.agentBody')}</span>
                  </button>
                  <button
                    type="button"
                    aria-pressed={kind === 'terminal'}
                    className={kind === 'terminal' ? 'picked' : ''}
                    onClick={() => setKind('terminal')}
                  >
                    <Terminal size={20} />
                    <strong>{t('workspaceDialog.terminal')}</strong>
                    <span>{t('workspaceDialog.terminalBody')}</span>
                  </button>
                </div>
                <label>
                  {t('workspaceDialog.sessionName')}{' '}
                  <span className="field-hint">{t('workspaceDialog.optional')}</span>
                  <input
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder={
                      kind === 'agent'
                        ? t('workspaceDialog.placeholderAgent')
                        : t('workspaceDialog.placeholderTerminal')
                    }
                    maxLength={200}
                  />
                </label>
                <label>
                  {t('workspaceDialog.workdir')}{' '}
                  <span className="field-hint">{t('workspaceDialog.workdirHint')}</span>
                  <input
                    value={workdir}
                    onChange={(e) => setWorkdir(e.target.value)}
                    placeholder={t('workspaceDialog.projectRoot')}
                  />
                </label>
                <p className="form-note">
                  <ShieldCheck size={14} />
                  {t('workspaceDialog.permissions')}
                </p>
              </div>
              <footer className="new-session-actions">
                <button type="button" className="button secondary" onClick={() => setDialog(null)}>
                  {t('shellText.cancel')}
                </button>
                <button
                  type="submit"
                  className="button primary"
                  disabled={pending || !sessionProject}
                >
                  {pending ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}
                  {kind === 'agent'
                    ? t('workspaceDialog.createAgent')
                    : t('workspaceDialog.createTerminal')}
                </button>
              </footer>
            </form>
          )}
          {dialog === 'preview' && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  await openPreview(preview, previewDevtools);
                  setDialog(null);
                });
              }}
            >
              <label>
                {t('workspaceDialog.previewUrl')}
                <input
                  type="url"
                  required
                  value={preview}
                  onChange={(e) => setPreview(e.target.value)}
                  placeholder="http://localhost:3000"
                />
              </label>
              <label className="form-check">
                <input
                  type="checkbox"
                  checked={previewDevtools}
                  onChange={(e) => setPreviewDevtools(e.target.checked)}
                />
                {t('workspaceDialog.devtools')}
              </label>
              <p className="form-note">{t('workspaceDialog.previewNote')}</p>
              <button type="submit" className="button primary full">
                {t('workspaceDialog.openPreview')}
                <ArrowUpRight size={16} />
              </button>
            </form>
          )}
        </Modal>
      )}
    </>
  );
}
