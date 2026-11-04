import { X } from 'lucide-react';
import { useDesktopText } from './desktop-i18n';
import { shortcutGroups } from './desktop-shortcuts';
import { Modal } from './Modal';
import './shortcuts.css';

/** Every desktop keyboard shortcut, by where it works. */
export function ShortcutsOverlay({ onClose }: { onClose: () => void }) {
  const { t } = useDesktopText();
  return (
    <Modal onClose={onClose}>
      <div className="composer-dialog shortcuts-dialog">
        <header>
          <h2 id="dialog-title">{t('shortcutsView.title')}</h2>
          <button
            type="button"
            className="icon-button"
            aria-label={t('shortcutsView.close')}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        {shortcutGroups().map((group) => (
          <section key={group.id} aria-label={t(`shortcutsView.group.${group.id}`)}>
            <h3>{t(`shortcutsView.group.${group.id}`)}</h3>
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
                  <dd>
                    {shortcut.id
                      ? t(`shortcutsView.item.${shortcut.id}`, {
                          defaultValue: shortcut.description,
                        })
                      : shortcut.description}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Modal>
  );
}
