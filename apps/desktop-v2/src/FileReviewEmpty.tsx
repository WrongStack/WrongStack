import { FileDiff } from 'lucide-react';
import { useDesktopText } from './desktop-i18n';

export function FileReviewEmpty({ hasChanges }: { hasChanges: boolean }) {
  const { t } = useDesktopText();
  return (
    <div className="file-review-empty">
      <FileDiff size={28} />
      <p>{hasChanges ? t('fileView.pickChange') : t('fileView.noChanges')}</p>
    </div>
  );
}
