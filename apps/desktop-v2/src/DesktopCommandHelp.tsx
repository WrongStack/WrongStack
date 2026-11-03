import { X } from 'lucide-react';
import { DESKTOP_CATEGORY_ORDER, desktopCommands } from './desktop-commands';
import { Modal } from './Modal';

/** Every desktop command by category; choosing one puts it in the draft. */
export function DesktopCommandHelp({
  onChoose,
  onClose,
}: {
  onChoose: (text: string) => void;
  onClose: () => void;
}) {
  return (
    <Modal onClose={onClose}>
      <div className="composer-dialog resource-dialog command-help">
        <header>
          <h2 id="dialog-title">Desktop commands</h2>
          <button
            type="button"
            className="icon-button"
            aria-label="Close desktop commands"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        <p>
          Choose to insert a command, then press Enter to run it. Unknown commands stay in your
          draft; use <code>{'//'}</code> for literal slash-prefixed text.
        </p>
        <div className="resource-list">
          {DESKTOP_CATEGORY_ORDER.map((category) => (
            <section key={category} className="command-group" aria-label={category}>
              <h3>{category}</h3>
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
                      {command.description}
                      {command.aliases?.length ? ` · also ${command.aliases.join(', ')}` : ''}
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
