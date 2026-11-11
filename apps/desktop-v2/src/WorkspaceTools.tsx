import {
  ArrowUpRight,
  BookOpen,
  BookOpenText,
  ClipboardList,
  Coins,
  Folder,
  Gauge,
  History,
  KeyRound,
  ListChecks,
  Palette,
  Plug,
  ShieldCheck,
  Terminal,
  X,
} from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useDesktopText } from './desktop-i18n';

export function WorkspaceTools({
  onClose,
  onActivity,
  onHistory,
  onSkills,
  onMcpTasks,
  onProcesses,
  onSideEffects,
  onUsage,
  onStory,
  onContext,
  onPlan,
  onDesign,
  onProject,
  onSettings,
}: {
  onClose: () => void;
  onActivity: () => void;
  onHistory: () => void;
  onSkills: () => void;
  onMcpTasks: () => void;
  onProcesses: () => void;
  onSideEffects: () => void;
  onUsage: () => void;
  onStory: () => void;
  onContext: () => void;
  onPlan: () => void;
  onDesign: () => void;
  onProject: () => void;
  onSettings: () => void;
}) {
  const { t } = useDesktopText();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="tools-dialog session-tools-dialog"
      aria-label={t('sessionTools.label')}
      onCancel={onClose}
    >
      <header>
        <div>
          <span className="eyebrow">{t('sessionTools.eyebrow')}</span>
          <h2>{t('sessionTools.title')}</h2>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label={t('sessionTools.close')}
          onClick={onClose}
        >
          <X size={17} />
        </button>
      </header>
      <div className="session-tool-choices">
        <button type="button" onClick={onDesign}>
          <Palette size={21} />
          <div>
            <strong>{t('chatView.designTitle')}</strong>
            <span>{t('designFlow.draftOnly')}</span>
          </div>
          <ArrowUpRight size={14} />
        </button>
        <button type="button" onClick={onStory}>
          <BookOpenText size={21} />
          <div>
            <strong>{t('sessionTools.story.title')}</strong>
            <span>{t('sessionTools.story.body')}</span>
          </div>
          <ArrowUpRight size={15} />
        </button>
        <button type="button" onClick={onContext}>
          <Gauge size={21} />
          <div>
            <strong>{t('sessionTools.context.title')}</strong>
            <span>{t('sessionTools.context.body')}</span>
          </div>
          <ArrowUpRight size={15} />
        </button>
        <button type="button" onClick={onUsage}>
          <Coins size={21} />
          <div>
            <strong>{t('sessionTools.usage.title')}</strong>
            <span>{t('sessionTools.usage.body')}</span>
          </div>
          <ArrowUpRight size={15} />
        </button>
        <button type="button" onClick={onSideEffects}>
          <ShieldCheck size={21} />
          <div>
            <strong>{t('sessionTools.sideEffects.title')}</strong>
            <span>{t('sessionTools.sideEffects.body')}</span>
          </div>
          <ArrowUpRight size={15} />
        </button>
        <button type="button" onClick={onProcesses}>
          <Terminal size={21} />
          <div>
            <strong>{t('sessionTools.processes.title')}</strong>
            <span>{t('sessionTools.processes.body')}</span>
          </div>
          <ArrowUpRight size={15} />
        </button>
        <button type="button" onClick={onMcpTasks}>
          <Plug size={21} />
          <div>
            <strong>{t('sessionTools.mcpTasks.title')}</strong>
            <span>{t('sessionTools.mcpTasks.body')}</span>
          </div>
          <ArrowUpRight size={15} />
        </button>
        <button type="button" onClick={onHistory}>
          <History size={21} />
          <div>
            <strong>{t('sessionTools.history.title')}</strong>
            <span>{t('sessionTools.history.body')}</span>
          </div>
          <ArrowUpRight size={15} />
        </button>
        <button type="button" onClick={onActivity}>
          <ListChecks size={21} />
          <div>
            <strong>{t('sessionTools.activity.title')}</strong>
            <span>{t('sessionTools.activity.body')}</span>
          </div>
          <ArrowUpRight size={15} />
        </button>
        <button type="button" onClick={onPlan}>
          <ClipboardList size={21} />
          <div>
            <strong>{t('sessionTools.plan.title')}</strong>
            <span>{t('sessionTools.plan.body')}</span>
          </div>
          <ArrowUpRight size={15} />
        </button>
        <button type="button" onClick={onSkills}>
          <BookOpen size={21} />
          <div>
            <strong>{t('sessionTools.skills.title')}</strong>
            <span>{t('sessionTools.skills.body')}</span>
          </div>
          <ArrowUpRight size={15} />
        </button>
      </div>
      <div className="session-tool-shared">
        <p>{t('sessionTools.shared')}</p>
        <button type="button" onClick={onProject}>
          <Folder size={16} />
          {t('sessionTools.projectWorkspace')}
          <span className="session-project-tools-hint">{t('sessionTools.projectHint')}</span>
          <ArrowUpRight size={14} />
        </button>
        <button type="button" onClick={onSettings}>
          <KeyRound size={16} />
          {t('sessionTools.settings')}
          <ArrowUpRight size={14} />
        </button>
      </div>
    </dialog>
  );
}
