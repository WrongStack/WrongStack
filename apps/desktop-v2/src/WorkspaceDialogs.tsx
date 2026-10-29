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
import { Modal } from './Modal';
import { visibleSessions } from './model';
import { openPreview } from './platform';

import type { DesktopController } from './useDesktop';

export function WorkspaceDialogs({ vm }: { vm: DesktopController }) {
  const {
    snapshot,
    setProject,
    setSelected,
    setSection,
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
              <span className="eyebrow">WRONGSTACK WORKSPACE</span>
              <h2 id="dialog-title">
                {dialog === 'session'
                  ? 'A fresh session.'
                  : dialog === 'preview'
                    ? 'Preview your work.'
                    : 'Find your next move.'}
              </h2>
            </div>
            <button
              type="button"
              className="icon-button"
              title="Close dialog"
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
                Project
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
                  <strong>Agent</strong>
                  <span>The full WrongStack engine</span>
                </button>
                <button
                  type="button"
                  aria-pressed={kind === 'terminal'}
                  className={kind === 'terminal' ? 'picked' : ''}
                  onClick={() => setKind('terminal')}
                >
                  <Terminal size={20} />
                  <strong>Terminal</strong>
                  <span>A persistent native shell</span>
                </button>
              </div>
              <label>
                Session name <span className="field-hint">optional</span>
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder={kind === 'agent' ? 'What are we building?' : 'Development terminal'}
                  maxLength={200}
                />
              </label>
              <label>
                Working directory <span className="field-hint">relative to project · optional</span>
                <input
                  value={workdir}
                  onChange={(e) => setWorkdir(e.target.value)}
                  placeholder="Project root"
                />
              </label>
              <p className="form-note">
                <ShieldCheck size={14} />
                Your existing WrongStack permissions apply.
              </p>
              <button
                type="submit"
                className="button primary full"
                disabled={pending || !sessionProject}
              >
                {pending ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}Create{' '}
                {kind} session
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
                Local preview URL
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
                Open developer tools
              </label>
              <p className="form-note">
                Opens in a separate native webview with no desktop IPC permissions and a private
                profile: cookies and storage are discarded when the preview closes.
              </p>
              <button type="submit" className="button primary full">
                Open preview
                <ArrowUpRight size={16} />
              </button>
            </form>
          )}
          {dialog === 'palette' && (
            <div className="palette">
              <div className="palette-input">
                <Search size={19} />
                <input
                  aria-label="Search projects and sessions"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search projects and sessions…"
                />
              </div>
              {snapshot.projects
                .filter((p) => p.name.toLowerCase().includes(search.toLowerCase()))
                .map((p) => (
                  <button
                    type="button"
                    key={p.id}
                    onClick={() => {
                      setProject(p.id);
                      setSelected(null);
                      setSection('fleet');
                      setDialog(null);
                      setSearch('');
                    }}
                  >
                    <Folder size={17} />
                    <span>{p.name}</span>
                    <small>PROJECT</small>
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
                    <span>{s.title}</span>
                    <small>{s.status}</small>
                    <ArrowRight size={15} />
                  </button>
                ))}
              {!snapshot.projects.length && (
                <p className="quiet-state">Connect your first project to get started.</p>
              )}
              <footer>
                <Command size={12} /> Ctrl K to toggle · Esc to close
              </footer>
            </div>
          )}
        </Modal>
      )}
    </>
  );
}
