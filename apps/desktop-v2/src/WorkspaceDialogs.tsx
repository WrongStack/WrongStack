import {
  ArrowRight,
  ArrowUpRight,
  Command,
  Folder,
  LoaderCircle,
  Plus,
  Search,
  ShieldCheck,
  Terminal,
  Workflow,
  X,
} from 'lucide-react';
import { useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import { Modal } from './Modal';
import { sessionStatus, sessionTitle, visibleSessions } from './model';
import { PaletteActions } from './PaletteActions';
import { openPreview } from './platform';

import type { DesktopController } from './useDesktop';

export function WorkspaceDialogs({ vm }: { vm: DesktopController }) {
  const { t } = useDesktopText();
  const {
    snapshot,
    search,
    setSearch,
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
    jumpToSession,
    createSession,
  } = vm;
  const [previewDevtools, setPreviewDevtools] = useState(false);
  return (
    <>
      {' '}
      {dialog && (
        <Modal onClose={() => setDialog(null)}>
          <header>
            <div>
              <span className="eyebrow">{t('workspaceDialog.eyebrow')}</span>
              <h2 id="dialog-title">
                {dialog === 'session'
                  ? t('workspaceDialog.title.session')
                  : dialog === 'preview'
                    ? t('workspaceDialog.title.preview')
                    : t('workspaceDialog.title.palette')}
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
              onSubmit={(e) => {
                e.preventDefault();
                void createSession();
              }}
            >
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
              <button
                type="submit"
                className="button primary full"
                disabled={pending || !sessionProject}
              >
                {pending ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}
                {kind === 'agent'
                  ? t('workspaceDialog.createAgent')
                  : t('workspaceDialog.createTerminal')}
              </button>
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
          {dialog === 'palette' && (
            <div className="palette">
              <div className="palette-input">
                <Search size={19} />
                <input
                  aria-label={t('workspaceDialog.searchLabel')}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={t('workspaceDialog.searchPlaceholder')}
                />
              </div>
              {snapshot.projects
                .filter((p) => p.name.toLowerCase().includes(search.toLowerCase()))
                .map((p) => (
                  <button
                    type="button"
                    key={p.id}
                    onClick={() => {
                      // The same destination as the project in the sidebar: its own page.
                      vm.openProjectPage(p.id);
                      setDialog(null);
                      setSearch('');
                    }}
                  >
                    <Folder size={17} />
                    <span>{p.name}</span>
                    <small>{t('workspaceDialog.projectTag')}</small>
                    <ArrowRight size={15} />
                  </button>
                ))}
              {visibleSessions(snapshot, null, search, 'all')
                .slice(0, 10)
                .map((s) => (
                  <button
                    type="button"
                    key={s.id}
                    onClick={() => {
                      jumpToSession(s);
                      setSearch('');
                    }}
                  >
                    <Terminal size={17} />
                    <span>{sessionTitle(s, t('workbench.untitled'))}</span>
                    <small>{t(`fleetView.status.${sessionStatus(s)}`)}</small>
                    <ArrowRight size={15} />
                  </button>
                ))}
              <PaletteActions vm={vm} search={search} />
              {!snapshot.projects.length && (
                <p className="quiet-state">{t('workspaceDialog.noProjects')}</p>
              )}
              <footer>
                <Command size={12} /> {t('workspaceDialog.footer')}
              </footer>
            </div>
          )}
        </Modal>
      )}
    </>
  );
}
