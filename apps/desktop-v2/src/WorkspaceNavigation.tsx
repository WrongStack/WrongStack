import {
  ChevronDown,
  FolderCode,
  GitCompareArrows,
  MessageSquare,
  PanelsTopLeft,
  Settings2,
} from 'lucide-react';
import { useDesktopText } from './desktop-i18n';
import type { EngineTab } from './engine-workspace-tabs';

/** Navigation stays outside the independently scrolling leader and agent transcripts. */
export function WorkspaceNavigation({
  tab,
  pending,
  onSelect,
  onTools,
  onSettings,
}: {
  tab: EngineTab;
  pending: number;
  onSelect: (tab: EngineTab) => void;
  onTools: () => void;
  onSettings: () => void;
}) {
  const { t } = useDesktopText();
  return (
    <nav className="workspace-tabs session-chat-navigation" aria-label={t('workspace.views')}>
      {(
        [
          { name: 'chat', label: t('workspace.chat'), Icon: MessageSquare },
          { name: 'files', label: t('workspace.files'), Icon: FolderCode },
          { name: 'changes', label: t('workspace.changes'), Icon: GitCompareArrows },
        ] as const
      ).map(({ name, label, Icon }) => (
        <button
          type="button"
          key={name}
          className={tab === name ? 'chosen-tab' : ''}
          aria-current={tab === name ? 'page' : undefined}
          onClick={() => onSelect(name)}
        >
          <Icon size={14} />
          {label}
          {name === 'chat' && pending > 0 && <span>{pending}</span>}
        </button>
      ))}
      <button
        type="button"
        className={
          [
            'activity',
            'skills',
            'history',
            'mcp-tasks',
            'processes',
            'side-effects',
            'usage',
            'story',
            'context',
            'plan',
          ].includes(tab)
            ? 'chosen-tab project-tools-button'
            : 'project-tools-button'
        }
        onClick={onTools}
      >
        <PanelsTopLeft size={14} />
        {t('workspace.tools')}
        <ChevronDown size={11} />
      </button>
      <button
        type="button"
        className="icon-button project-tools-button"
        aria-label={t('workspace.settings')}
        title={t('workspace.settingsTitle')}
        onClick={onSettings}
      >
        <Settings2 size={15} />
      </button>
    </nav>
  );
}
