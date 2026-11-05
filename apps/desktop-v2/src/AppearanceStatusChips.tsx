import { Check } from 'lucide-react';
import type { Appearance } from './appearance';
import { statusChips, toggleStatusChip } from './appearance-status';
import { useDesktopText } from './desktop-i18n';

/** Chooses what a conversation's status bar shows, as the TUI's `/statusline` picker does. */
export function AppearanceStatusChips({
  appearance,
  changeAppearance,
}: {
  appearance: Appearance;
  changeAppearance: (patch: Partial<Appearance>) => void;
}) {
  const { t } = useDesktopText();
  return (
    <div className="appearance-section">
      <div>
        <h3>{t('appearance.statusBar.title')}</h3>
        <p>{t('appearance.statusBar.body')}</p>
      </div>
      <fieldset className="appearance-modes" aria-label={t('appearance.statusBar.title')}>
        {statusChips.map((chip) => {
          const visible = !appearance.statusHidden?.includes(chip);
          return (
            <button
              type="button"
              key={chip}
              aria-pressed={visible}
              onClick={() =>
                changeAppearance({
                  statusHidden: toggleStatusChip(appearance.statusHidden, chip, !visible),
                })
              }
            >
              <span>{t(`appearance.statusBar.chip.${chip}`)}</span>
              {visible && <Check size={13} />}
            </button>
          );
        })}
      </fieldset>
    </div>
  );
}
