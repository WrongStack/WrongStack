import { FolderOpen } from 'lucide-react';
import { useDesktopText } from './desktop-i18n';

export function FileExplorerFooter({
  count,
  includeIgnored,
}: {
  count: number;
  includeIgnored: boolean;
}) {
  const { t } = useDesktopText();
  return (
    <footer>
      {t('shellText.visibleFiles', { count })}
      <span>{includeIgnored ? t('fileView.ignoredIncluded') : t('fileView.ignoredExcluded')}</span>
    </footer>
  );
}

export function FileExplorerTab({
  selected,
  onSelect,
}: {
  selected: boolean;
  onSelect: () => void;
}) {
  const { t } = useDesktopText();
  return (
    <button type="button" className={selected ? 'file-tab-current' : ''} onClick={onSelect}>
      <FolderOpen size={13} />
      {t('fileView.explorerTab')}
    </button>
  );
}
