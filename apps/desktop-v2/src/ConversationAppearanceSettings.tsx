import { useTranslation } from 'react-i18next';
import type { Appearance } from './appearance';
import { type ConversationDisplay, conversationDisplay } from './conversation-appearance';
import { useDesktopText } from './desktop-i18n';
import { surfaceI18n } from './surface-i18n';
import './conversation-appearance.css';

export function ConversationAppearanceSettings({
  appearance,
  changeAppearance,
}: {
  appearance: Appearance;
  changeAppearance: (patch: Partial<Appearance>) => void;
}) {
  const { t } = useDesktopText();
  const { t: shared } = useTranslation('settings', { i18n: surfaceI18n });
  const current = conversationDisplay(appearance);
  const rows: Array<{ key: keyof ConversationDisplay; label: string; hint: string }> = [
    {
      key: 'showThinkingLogs',
      label: shared('settings:general.showThinkingLabel'),
      hint: shared('settings:general.showThinkingHint'),
    },
    {
      key: 'groupToolCalls',
      label: shared('settings:general.groupToolCallsLabel'),
      hint: shared('settings:general.groupToolCallsHint'),
    },
    {
      key: 'autoCollapseInput',
      label: shared('settings:general.autoCollapseInputLabel'),
      hint: shared('settings:general.autoCollapseInputHint'),
    },
    {
      key: 'keyboardShortcuts',
      label: shared('settings:display.keyboardShortcutsLabel'),
      hint: t('appearance.conversation.keyboardHint'),
    },
  ];
  return (
    <section
      className="appearance-section conversation-appearance"
      aria-label={t('appearance.conversation.title')}
    >
      <div>
        <h3>{t('appearance.conversation.title')}</h3>
        <p>{t('appearance.conversation.body')}</p>
      </div>
      <div className="conversation-appearance-toggles">
        {rows.map((row) => (
          <label key={row.key}>
            <input
              type="checkbox"
              checked={current[row.key]}
              onChange={(event) => changeAppearance({ [row.key]: event.target.checked })}
            />
            <span>
              <strong>{row.label}</strong>
              <small>{row.hint}</small>
            </span>
          </label>
        ))}
      </div>
    </section>
  );
}
