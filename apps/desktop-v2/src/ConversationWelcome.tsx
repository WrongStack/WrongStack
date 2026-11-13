/**
 * ConversationWelcome — what an empty conversation shows before its first prompt.
 *
 * The WebUI opens a session on a hero (project, model, working directory) with starting
 * points; the desktop showed a single line over an empty page. A starting point only fills
 * the composer — nothing is sent until the user does.
 */

import {
  Bug,
  FileCode2,
  FlaskConical,
  GitPullRequest,
  LoaderCircle,
  Map as MapIcon,
} from 'lucide-react';
import { useDesktopText } from './desktop-i18n';
import './conversation-welcome.css';
// The DESIGN.md callout shares Design Studio's look.
import './project-design-studio.css';

const STARTERS = [
  { id: 'Explain', Icon: MapIcon },
  { id: 'Bug', Icon: Bug },
  { id: 'Review', Icon: GitPullRequest },
  { id: 'Tests', Icon: FlaskConical },
] as const;

export function ConversationWelcome({
  projectRoot,
  provider,
  model,
  connected,
  onStart,
  onOpenDesign,
}: {
  projectRoot?: string | undefined;
  provider: string;
  model: string;
  connected: boolean;
  /** Puts a starting prompt into the composer. */
  onStart: (prompt: string) => void;
  /**
   * Opens the conversation's DESIGN.md reference dialog. The welcome offers it in one line, as
   * Design Studio does: the whole form here pushed the starting points below the fold and the
   * welcome's heading out of view.
   */
  onOpenDesign?: (() => void) | undefined;
}) {
  const { t } = useDesktopText();
  const root = projectRoot?.replace(/^\\\\\?\\/, '');
  const project = root?.split(/[\\/]/).filter(Boolean).at(-1);
  return (
    <div className="native-chat-welcome conversation-welcome">
      <section className="conversation-welcome-hero">
        <span className="conversation-welcome-eyebrow">
          {project ? `${project} / ` : ''}
          {t('chatView.welcomeEyebrow')}
        </span>
        <h2>
          {t('chatView.welcome')}
          {!connected && <LoaderCircle size={18} className="spin" />}
        </h2>
        <p>{t('chatView.welcomeBody')}</p>
        <dl>
          {model && (
            <div>
              <dt>{t('chatView.welcomeModel')}</dt>
              <dd>{provider ? `${provider} / ${model}` : model}</dd>
            </div>
          )}
          {root && (
            <div>
              <dt>{t('chatView.welcomeDirectory')}</dt>
              <dd title={root}>{root}</dd>
            </div>
          )}
        </dl>
      </section>
      {onOpenDesign && (
        <div className="design-extract-callout">
          <FileCode2 size={16} />
          <div>
            <strong>{t('chatView.designTitle')}</strong>
            <span>{t('chatView.designBody')}</span>
          </div>
          <button type="button" className="button secondary small" onClick={onOpenDesign}>
            {t('designFlow.launch')}
          </button>
        </div>
      )}
      <div className="conversation-welcome-starters">
        {STARTERS.map(({ id, Icon }) => (
          <button
            type="button"
            key={id}
            className="conversation-welcome-starter"
            onClick={() => onStart(t(`chatView.starter${id}Prompt`))}
          >
            <Icon size={18} />
            <span>
              <strong>{t(`chatView.starter${id}Title`)}</strong>
              <small>{t(`chatView.starter${id}Prompt`)}</small>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
