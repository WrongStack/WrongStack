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
import { useDesktopText } from './desktop-i18n';
import { displayDate, displayDateTime } from './display-dates';
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
  const { t } = useDesktopText();
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
    <section className="git-history-workspace" aria-label={t('history.label')}>
      <header className="git-history-toolbar">
        <button
          type="button"
          className="icon-button"
          aria-label={t('history.back')}
          onClick={onBack}
        >
          <ArrowLeft size={16} />
        </button>
        <GitBranch size={17} />
        <strong>{t('history.label')}</strong>
        <span>{String(data['currentBranch'] ?? t('history.readingRepo'))}</span>
        <label>
          <Search size={14} />
          <input
            aria-label={t('history.search')}
            placeholder={t('history.searchPlaceholder')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <select aria-label={t('history.ref')} value={ref} onChange={(e) => setRef(e.target.value)}>
          <option value="">{t('history.allRefs')}</option>
          {entries(data['refs']).map((item) => (
            <option key={String(item['name'])} value={String(item['name'])}>
              {String(item['shortName'])}
              {item['current'] ? ` · ${t('history.current')}` : ''}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="icon-button"
          aria-label={t('history.refresh')}
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
        <aside className="git-commit-list" aria-label={t('history.commits')}>
          <header>
            <span>{t('history.commitsHeading')}</span>
            <small>{t('history.loaded', { count: commits.length })}</small>
          </header>
          {busy && !commits.length && (
            <p className="file-quiet-state">{t('history.readingCommits')}</p>
          )}
          {!busy && !commits.length && (
            <div className="chronicle-empty">
              <GitCommitHorizontal size={30} />
              <h2>{t('history.noCommits')}</h2>
              <p>{data['repoRoot'] ? t('history.emptySelection') : t('history.noRepo')}</p>
            </div>
          )}
          {visible.map((commit, index) => (
            <button
              type="button"
              key={String(commit['hash'])}
              aria-label={t('history.inspect', { subject: String(commit['subject']) })}
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
                  {String(commit['author'])} · {displayDate(String(commit['authoredAt']))}
                  <code>{String(commit['hash']).slice(0, 8)}</code>
                </small>
              </div>
            </button>
          ))}
          {!busy && commits.length > 0 && !visible.length && (
            <p className="file-quiet-state">{t('history.noMatch')}</p>
          )}
          {data['hasMore'] === true && (
            <button
              type="button"
              className="git-history-more"
              disabled={busy}
              onClick={() => void load(commits.length)}
            >
              {busy ? t('history.reading') : t('history.older')}
            </button>
          )}
        </aside>
        <main className="git-commit-detail">
          {detail ? (
            <>
              <header>
                <h1>{String(detail['body'] ?? '').split('\n')[0]}</h1>
                <p>
                  {String(detail['author'])} <span>{String(detail['email'])}</span> ·{' '}
                  {displayDateTime(String(detail['authoredAt']))}
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
                  <span>{t('history.parents')}</span>
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
                    <small>{t('history.initial')}</small>
                  )}
                </div>
              </header>
              <div className="git-commit-stats">
                <strong>{t('history.filesChanged', { count: files.length })}</strong>
                <span className="diff-added">
                  +{files.reduce((sum, file) => sum + Number(file['added'] ?? 0), 0)}
                </span>
                <span className="diff-removed">
                  −{files.reduce((sum, file) => sum + Number(file['deleted'] ?? 0), 0)}
                </span>
                <small>
                  {Array.isArray(detail['parents']) && detail['parents'].length
                    ? t('history.comparedParent')
                    : t('history.comparedEmpty')}
                </small>
              </div>
              {detail['truncated'] === true && (
                <p className="chronicle-footnote">{t('history.truncated')}</p>
              )}
              <div className="git-commit-files">
                {files.map((file) => (
                  <button
                    type="button"
                    key={String(file['path'])}
                    aria-label={t('history.viewDiff', { path: String(file['path']) })}
                    className={diff?.['path'] === file['path'] ? 'selected-commit-file' : ''}
                    onClick={() => void readDiff(file)}
                  >
                    <FileCode2 size={14} />
                    <span>
                      {String(file['path'])}
                      {typeof file['previousPath'] === 'string' && (
                        <small>
                          {t('history.renamedFrom', { path: String(file['previousPath']) })}
                        </small>
                      )}
                    </span>
                    {file['binary'] ? (
                      <small>{t('history.binary')}</small>
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
                  {t('history.readingContent')}
                </p>
              )}
              {diff && (
                <div className="git-commit-diff">
                  <header>
                    <code>{String(diff['path'])}</code>
                    <button type="button" onClick={() => onOpenFile(String(diff['path']))}>
                      {t('history.openFile')}
                      <ArrowRight size={13} />
                    </button>
                  </header>
                  {diff['binary'] || diff['tooLarge'] ? (
                    <p className="file-quiet-state">
                      {diff['binary'] ? t('history.binaryDiff') : t('history.tooLarge')}
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
              <h1>{reading ? t('history.readingCommit') : t('history.story')}</h1>
              <p>{t('history.storyHelp')}</p>
            </div>
          )}
        </main>
      </div>
    </section>
  );
}
