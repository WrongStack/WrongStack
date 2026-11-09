import { ChevronDown, ChevronUp, Square } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useDesktopText } from './desktop-i18n';
import { surfaceI18n } from './surface-i18n';
import './conversation-appearance.css';

export function ComposerFoldControls({
  collapsed,
  running,
  draft,
  onExpand,
  onCollapse,
  onStop,
}: {
  collapsed: boolean;
  running: boolean;
  draft: string;
  onExpand: () => void;
  onCollapse: () => void;
  onStop: () => void;
}) {
  const { t } = useDesktopText();
  const { t: chat } = useTranslation('chat', { i18n: surfaceI18n });
  return (
    <div className="composer-fold-controls">
      <button
        type="button"
        className="button secondary"
        aria-expanded={!collapsed}
        onClick={collapsed ? onExpand : onCollapse}
      >
        {collapsed ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        {chat(collapsed ? 'chat:input.expandInput' : 'chat:input.collapseInput')}
      </button>
      {collapsed && (
        <>
          {draft.trim() && <span className="composer-fold-draft">{draft.slice(0, 160)}</span>}
          {running && (
            <button type="button" className="button secondary" onClick={onStop}>
              <Square size={12} />
              {t('chatView.stopRun')}
            </button>
          )}
        </>
      )}
    </div>
  );
}
