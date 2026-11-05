import { X } from 'lucide-react';
import { Trans } from 'react-i18next';
import { commandCategory, commandDescription } from './desktop-command-text';
import { DESKTOP_CATEGORY_ORDER, desktopCommands } from './desktop-commands';
import { useDesktopText } from './desktop-i18n';
import { Modal } from './Modal';
import { surfaceI18n } from './surface-i18n';
import './composer-dialog.css';

/** Every desktop command by category; choosing one puts it in the draft. */
export function DesktopCommandHelp({
  onChoose,
  onClose,
}: {
  onChoose: (text: string) => void;
  onClose: () => void;
}) {
  const { t } = useDesktopText();
  return (
    <Modal onClose={onClose}>
      <div className="composer-dialog resource-dialog command-help">
        <header>
          <h2 id="dialog-title">{t('commandHelp.title')}</h2>
          <button
            type="button"
            className="icon-button"
            aria-label={t('commandHelp.close')}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        <p>
          <Trans
            i18n={surfaceI18n}
            ns="desktop"
            i18nKey="commandHelp.intro"
            components={{ code: <code /> }}
          />
        </p>
        <div className="resource-list">
          {DESKTOP_CATEGORY_ORDER.map((category) => (
            <section
              key={category}
              className="command-group"
              aria-label={commandCategory(category, t)}
            >
              <h3>{commandCategory(category, t)}</h3>
              {desktopCommands
                .filter((command) => command.category === category)
                .map((command) => (
                  <button
                    type="button"
                    key={command.name}
                    onClick={() => onChoose(`${command.name} `)}
                  >
                    <strong>
                      {command.name}
                      {command.usage && <small> {command.usage}</small>}
                    </strong>
                    <span>
                      {commandDescription(command, t)}
                      {command.aliases?.length
                        ? ` · ${t('commandHelp.also', { aliases: command.aliases.join(', ') })}`
                        : ''}
                    </span>
                  </button>
                ))}
            </section>
          ))}
        </div>
      </div>
    </Modal>
  );
}
