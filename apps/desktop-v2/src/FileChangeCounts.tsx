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
