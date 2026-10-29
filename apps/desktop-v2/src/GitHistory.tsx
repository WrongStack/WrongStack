import {
  ArrowLeft,
  ArrowRight,
  Check,
  Copy,
  FileCode2,
  GitBranch,
  GitCommitHorizontal,
  LoaderCircle,
  RefreshCw,
  Search,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DiffPreview } from './DiffPreview';
import type { EngineCommand } from './engine-operations';
import { entries } from './engine-values';
import { GitGraphCell } from './GitGraphCell';
import { commitGraph } from './git-graph';

export function GitHistory({
  command,
  onBack,
  onOpenFile,
}: {
  command: EngineCommand;
  onBack: () => void;
  onOpenFile: (path: string) => void;
}) {
  const [data, setData] = useState<Record<string, unknown>>({}),
    [detail, setDetail] = useState<Record<string, unknown> | null>(null);
  const [diff, setDiff] = useState<Record<string, unknown> | null>(null),
    [ref, setRef] = useState(''),
    [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false),
    [reading, setReading] = useState(false),
    [error, setError] = useState(''),
    [copied, setCopied] = useState(false);
  const generation = useRef(0),
    detailGeneration = useRef(0),
    diffGeneration = useRef(0);
  const load = useCallback(
    async (skip = 0) => {
      const id = ++generation.current;
      setBusy(true);
      setError('');
      try {
        const result = await command('git.history', { ref, limit: 100, skip }, ['git.history'], {
          timeoutMs: 30000,
        });
        if (id === generation.current)
          setData((current) =>
            skip
              ? {
                  ...result,
                  commits: [...entries(current['commits']), ...entries(result['commits'])],
                }
              : result,
          );
      } catch (e) {
        if (id === generation.current) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (id === generation.current) setBusy(false);
      }
    },
    [command, ref],
  );
  useEffect(() => {
    setDetail(null);
    setDiff(null);
    detailGeneration.current++;
    diffGeneration.current++;
    void load();
    return () => {
      generation.current++;
      detailGeneration.current++;
      diffGeneration.current++;
    };
  }, [load]);
  const inspect = async (hash: string) => {
    const id = ++detailGeneration.current;
    diffGeneration.current++;
    setDetail(null);
    setDiff(null);
    setReading(true);
    setError('');
    setCopied(false);
    try {
      const result = await command('git.commit_detail', { hash }, ['git.commit_detail'], {
        timeoutMs: 30000,
      });
      if (id === detailGeneration.current) setDetail(result);
    } catch (e) {
      if (id === detailGeneration.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (id === detailGeneration.current) setReading(false);
    }
  };
  const readDiff = async (file: Record<string, unknown>) => {
    const id = ++diffGeneration.current;
    setReading(true);
    setError('');
    setDiff(null);
    try {
      const result = await command(
        'git.commit_file_diff',
        {
          hash: detail?.['fullHash'] ?? detail?.['hash'],
          path: file['path'],
          ...(file['previousPath'] ? { previousPath: file['previousPath'] } : {}),
        },
        ['git.commit_file_diff'],
        { timeoutMs: 30000 },
      );
      if (id === diffGeneration.current) setDiff(result);
    } catch (e) {
      if (id === diffGeneration.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (id === diffGeneration.current) setReading(false);
    }
  };
  const commits = entries(data['commits']),
    visible = commits.filter((commit) =>
      `${commit['subject']} ${commit['author']} ${commit['hash']}`
        .toLowerCase()
        .includes(search.toLowerCase()),
    );
  // Lanes are only meaningful over the unfiltered list; a search shows plain markers.
  const graph = useMemo(
    () =>
      commitGraph(
        entries(data['commits']).map((commit) => ({
          hash: String(commit['hash']),
          parents: Array.isArray(commit['parents']) ? commit['parents'].map(String) : [],
        })),
      ),
    [data],
  );
  const showGraph = !search.trim();
  const files = entries(detail?.['files']);
  return (
    <section className="git-history-workspace" aria-label="Repository history">
      <header className="git-history-toolbar">
        <button
          type="button"
          className="icon-button"
          aria-label="Back to working changes"
          onClick={onBack}
        >
          <ArrowLeft size={16} />
        </button>
        <GitBranch size={17} />
        <strong>Repository history</strong>
        <span>{String(data['currentBranch'] ?? 'Reading repository…')}</span>
        <label>
          <Search size={14} />
          <input
            aria-label="Search loaded commits"
            placeholder="Search loaded commits…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <select
          aria-label="History branch or tag"
          value={ref}
          onChange={(e) => setRef(e.target.value)}
        >
          <option value="">All branches & tags</option>
          {entries(data['refs']).map((item) => (
            <option key={String(item['name'])} value={String(item['name'])}>
              {String(item['shortName'])}
              {item['current'] ? ' · current' : ''}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="icon-button"
          aria-label="Refresh repository history"
          disabled={busy}
          onClick={() => void load()}
        >
          <RefreshCw size={15} />
        </button>
      </header>
      {error && (
        <p role="alert" className="file-workspace-error">
          {error}
        </p>
      )}
      <div className="git-history-body">
        <aside className="git-commit-list" aria-label="Commit history">
          <header>
            <span>COMMIT HISTORY</span>
            <small>{commits.length} loaded</small>
          </header>
          {busy && !commits.length && <p className="file-quiet-state">Reading commits…</p>}
          {!busy && !commits.length && (
            <div className="chronicle-empty">
              <GitCommitHorizontal size={30} />
              <h2>No commits yet.</h2>
              <p>
                {data['repoRoot']
                  ? 'The selected history has no commits.'
                  : 'Choose a project inside a Git repository with committed history.'}
              </p>
            </div>
          )}
          {visible.map((commit, index) => (
            <button
              type="button"
              key={String(commit['hash'])}
              aria-label={`Inspect commit ${String(commit['subject'])}`}
              className={detail?.['fullHash'] === commit['hash'] ? 'selected-commit' : ''}
              onClick={() => void inspect(String(commit['hash']))}
            >
              {showGraph && graph[index] ? (
                <GitGraphCell
                  row={graph[index]}
                  merge={Array.isArray(commit['parents']) && commit['parents'].length > 1}
                />
              ) : (
                <span
                  className={`git-commit-dot ${Array.isArray(commit['parents']) && commit['parents'].length > 1 ? 'git-merge-dot' : ''}`}
                />
              )}
              <div>
                <strong>{String(commit['subject'])}</strong>
                <span className="git-commit-refs">
                  {Array.isArray(commit['refs']) &&
                    commit['refs'].map((name: unknown) => <b key={String(name)}>{String(name)}</b>)}
                </span>
                <small>
                  {String(commit['author'])} ·{' '}
                  {new Date(String(commit['authoredAt'])).toLocaleDateString()}
                  <code>{String(commit['hash']).slice(0, 8)}</code>
                </small>
              </div>
            </button>
          ))}
          {!busy && commits.length > 0 && !visible.length && (
            <p className="file-quiet-state">No loaded commits match this search.</p>
          )}
          {data['hasMore'] === true && (
            <button
              type="button"
              className="git-history-more"
              disabled={busy}
              onClick={() => void load(commits.length)}
            >
              {busy ? 'Reading…' : 'Load older commits'}
            </button>
          )}
        </aside>
        <main className="git-commit-detail">
          {detail ? (
            <>
              <header>
                <span className="eyebrow">COMMITTED CHANGE</span>
                <h1>{String(detail['body'] ?? '').split('\n')[0]}</h1>
                <p>
                  {String(detail['author'])} <span>{String(detail['email'])}</span> ·{' '}
                  {new Date(String(detail['authoredAt'])).toLocaleString()}
                </p>
                <button
                  type="button"
                  className="git-copy-hash"
                  onClick={() => {
                    void navigator.clipboard
                      .writeText(String(detail['fullHash']))
                      .then(() => setCopied(true))
                      .catch((e) => setError(String(e)));
                  }}
                >
                  {copied ? <Check size={13} /> : <Copy size={13} />}
                  <code>{String(detail['fullHash'])}</code>
                </button>
                {String(detail['body'] ?? '').includes('\n') && (
                  <p className="git-commit-message">
                    {String(detail['body']).split('\n').slice(1).join('\n').trim()}
                  </p>
                )}
                <div className="git-parent-commits">
                  <span>Parents</span>
                  {Array.isArray(detail['parents']) && detail['parents'].length ? (
                    detail['parents'].map((parent: unknown) => (
                      <button
                        type="button"
                        key={String(parent)}
                        onClick={() => void inspect(String(parent))}
                      >
                        {String(parent).slice(0, 10)}
                        <ArrowRight size={12} />
                      </button>
                    ))
                  ) : (
                    <small>Initial commit</small>
                  )}
                </div>
              </header>
              <div className="git-commit-stats">
                <strong>{files.length} files changed</strong>
                <span className="diff-added">
                  +{files.reduce((sum, file) => sum + Number(file['added'] ?? 0), 0)}
                </span>
                <span className="diff-removed">
                  −{files.reduce((sum, file) => sum + Number(file['deleted'] ?? 0), 0)}
                </span>
                <small>
                  Compared with{' '}
                  {Array.isArray(detail['parents']) && detail['parents'].length
                    ? 'the first parent'
                    : 'the empty tree'}
                </small>
              </div>
              {detail['truncated'] === true && (
                <p className="chronicle-footnote">
                  This commit has more than 400 changed files. The engine returned a bounded file
                  list.
                </p>
              )}
              <div className="git-commit-files">
                {files.map((file) => (
                  <button
                    type="button"
                    key={String(file['path'])}
                    aria-label={`View committed diff ${String(file['path'])}`}
                    className={diff?.['path'] === file['path'] ? 'selected-commit-file' : ''}
                    onClick={() => void readDiff(file)}
                  >
                    <FileCode2 size={14} />
                    <span>
                      {String(file['path'])}
                      {typeof file['previousPath'] === 'string' && (
                        <small>Renamed from {String(file['previousPath'])}</small>
                      )}
                    </span>
                    {file['binary'] ? (
                      <small>Binary</small>
                    ) : (
                      <>
                        <b className="diff-added">+{String(file['added'])}</b>
                        <b className="diff-removed">−{String(file['deleted'])}</b>
                      </>
                    )}
                    <ArrowRight size={13} />
                  </button>
                ))}
              </div>
              {reading && (
                <p className="file-quiet-state">
                  <LoaderCircle className="spin" size={18} />
                  Reading committed content…
                </p>
              )}
              {diff && (
                <div className="git-commit-diff">
                  <header>
                    <code>{String(diff['path'])}</code>
                    <button type="button" onClick={() => onOpenFile(String(diff['path']))}>
                      Open working file
                      <ArrowRight size={13} />
                    </button>
                  </header>
                  {diff['binary'] || diff['tooLarge'] ? (
                    <p className="file-quiet-state">
                      {diff['binary']
                        ? 'Binary changes cannot be displayed as text.'
                        : 'This change exceeds the engine preview size limit.'}
                    </p>
                  ) : (
                    <DiffPreview
                      before={String(diff['oldText'] ?? '')}
                      after={String(diff['newText'] ?? '')}
                      path={String(diff['path'])}
                    />
                  )}
                </div>
              )}
            </>
          ) : (
            <div className="git-history-placeholder">
              <GitCommitHorizontal size={42} />
              <h1>{reading ? 'Reading commit…' : 'Every change has a story.'}</h1>
              <p>
                Select a commit to inspect its author, parents, changed files, and line-by-line
                diff.
              </p>
            </div>
          )}
        </main>
      </div>
    </section>
  );
}
