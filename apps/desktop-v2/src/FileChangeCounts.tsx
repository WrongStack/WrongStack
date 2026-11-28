import { useDesktopText } from './desktop-i18n';

/**
 * A changed file's added and removed line counts ("+8 −3"), as the WebUI's change list shows
 * them. Nothing for a file git reports no lines for (untracked, binary, mode-only).
 */
export function FileChangeCounts({ added, deleted }: { added: unknown; deleted: unknown }) {
  const { t } = useDesktopText();
  const plus = typeof added === 'number' ? added : 0;
  const minus = typeof deleted === 'number' ? deleted : 0;
  if (!plus && !minus) return null;
  return (
    <span
      className="file-change-counts"
      title={t('fileView.lineCounts', { added: plus, deleted: minus })}
    >
      {plus > 0 && <span className="git-added">+{plus}</span>}
      {minus > 0 && <span className="git-deleted">−{minus}</span>}
    </span>
  );
}

/** Git's change kinds, in the order the summary draws them. */
const GIT_KINDS = ['M', 'A', 'D', 'R', 'C', 'U', 'untracked'] as const;
type GitKind = (typeof GIT_KINDS)[number];

/** The kind a git status letter names; an untracked file is "?". Unknown letters read as modified. */
export function gitKind(status: unknown): GitKind {
  const letter = String(status ?? '').charAt(0);
  if (letter === '?') return 'untracked';
  return (GIT_KINDS as readonly string[]).includes(letter) ? (letter as GitKind) : 'M';
}

/**
 * The change list at a glance: one bar split by change kind, each kind's count, and the lines
 * added and removed across every file.
 */
export function FileChangeSummary({ changes }: { changes: Record<string, unknown>[] }) {
  const { t } = useDesktopText();
  if (!changes.length) return null;
  const counts = new Map<GitKind, number>();
  let added = 0;
  let deleted = 0;
  for (const file of changes) {
    const kind = gitKind(file['status']);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
    if (typeof file['added'] === 'number') added += file['added'];
    if (typeof file['deleted'] === 'number') deleted += file['deleted'];
  }
  const kinds = GIT_KINDS.filter((kind) => counts.has(kind));
  const lines = added + deleted;
  return (
    <div className="file-change-summary">
      <div className="file-change-summary-bar" aria-hidden="true">
        {kinds.map((kind) => (
          <i key={kind} className={`status-${kind}`} style={{ flexGrow: counts.get(kind) }} />
        ))}
      </div>
      <ul className="file-change-summary-kinds">
        {kinds.map((kind) => {
          const label = t(`fileView.gitStatus.${kind}`, { count: counts.get(kind) });
          return (
            <li key={kind} className={`status-${kind}`} title={label} aria-label={label}>
              <b aria-hidden="true">{kind === 'untracked' ? '?' : kind}</b>
              <span aria-hidden="true">{counts.get(kind)}</span>
            </li>
          );
        })}
        {lines > 0 && (
          <li className="file-change-summary-lines">
            <FileChangeCounts added={added} deleted={deleted} />
            <span className="file-change-ratio" aria-hidden="true">
              <i style={{ flexGrow: added }} />
              <i style={{ flexGrow: deleted }} />
            </span>
          </li>
        )}
      </ul>
    </div>
  );
}

/** Stage (or unstage) every file in a change group, as the WebUI's change list offers. */
export function StageAllButton({
  staged,
  shown,
  busy,
  onClick,
}: {
  staged: boolean;
  shown: boolean;
  busy: boolean;
  onClick: () => void;
}) {
  const { t } = useDesktopText();
  if (!shown) return null;
  return (
    <button type="button" className="file-stage-all" disabled={busy} onClick={onClick}>
      {staged ? t('fileView.unstageAll') : t('fileView.stageAll')}
    </button>
  );
}
