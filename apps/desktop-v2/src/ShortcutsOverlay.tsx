import { X } from 'lucide-react';
import { shortcutGroups } from './desktop-shortcuts';
import { Modal } from './Modal';
import './shortcuts.css';

/** Every desktop keyboard shortcut, by where it works. */
export function ShortcutsOverlay({ onClose }: { onClose: () => void }) {
  return (
    <Modal onClose={onClose}>
      <div className="composer-dialog shortcuts-dialog">
        <header>
          <h2 id="dialog-title">Keyboard shortcuts</h2>
          <button
            type="button"
            className="icon-button"
            aria-label="Close keyboard shortcuts"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        {shortcutGroups().map((group) => (
          <section key={group.title} aria-label={group.title}>
            <h3>{group.title}</h3>
            <dl>
              {group.shortcuts.map((shortcut) => (
                <div key={`${shortcut.keys.join('+')}:${shortcut.description}`}>
                  <dt>
                    {shortcut.keys.map((key, index) => (
                      <span key={key}>
                        {index > 0 && ' + '}
                        <kbd>{key}</kbd>
                      </span>
                    ))}
                  </dt>
                  <dd>{shortcut.description}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Modal>
  );
}
