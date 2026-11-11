import { Check } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import type { Appearance } from './appearance';
import {
  codeFontStack,
  DEFAULT_CODE_STACK,
  DEFAULT_UI_STACK,
  fontFamilyName,
  textSizes,
  uiFontStack,
} from './appearance-fonts';
import { useDesktopText } from './desktop-i18n';

const SAMPLE = 'Aa Bb Çç Ğğ Şş 0123 => !== {}';

/** A typeface choice with the installed-font field that "custom" opens. */
function FontChoice({
  label,
  value,
  family,
  options,
  sample,
  onChoose,
  onFamily,
}: {
  label: string;
  value: string;
  family: string | undefined;
  options: { id: string; label: string }[];
  sample: string;
  onChoose: (choice: string) => void;
  /** A typed family name; undefined when it is empty or not a plain name. */
  onFamily: (family: string | undefined) => void;
}) {
  const { t } = useDesktopText();
  const selectId = useId();
  const [draft, setDraft] = useState(family ?? '');
  useEffect(() => setDraft(family ?? ''), [family]);
  const commit = () => {
    const name = fontFamilyName(draft);
    if (name !== family) onFamily(name);
  };
  return (
    <div className="appearance-font">
      <label htmlFor={selectId}>{label}</label>
      <select id={selectId} value={value} onChange={(event) => onChoose(event.target.value)}>
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
      {value === 'custom' && (
        <input
          aria-label={t('appearance.fonts.familyLabel')}
          placeholder={t('appearance.fonts.familyPlaceholder')}
          value={draft}
          spellCheck={false}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit();
          }}
        />
      )}
      <span className="appearance-font-sample" style={{ fontFamily: sample }} aria-hidden="true">
        {SAMPLE}
      </span>
    </div>
  );
}

/**
 * Interface and code font choices, window zoom and code ligatures.
 */
export function AppearanceFonts({
  appearance,
  changeAppearance,
}: {
  appearance: Appearance;
  changeAppearance: (patch: Partial<Appearance>) => void;
}) {
  const { t } = useDesktopText();
  return (
    <>
      <div className="appearance-section">
        <div>
          <h3>{t('appearance.fonts.title')}</h3>
          <p>{t('appearance.fonts.body')}</p>
        </div>
        <div className="appearance-fonts">
          <FontChoice
            label={t('appearance.fonts.uiLabel')}
            value={appearance.uiFont ?? 'default'}
            family={appearance.uiFontFamily}
            sample={uiFontStack(appearance) ?? DEFAULT_UI_STACK}
            options={[
              { id: 'default', label: t('appearance.fonts.geist') },
              { id: 'system', label: t('appearance.fonts.system') },
              { id: 'custom', label: t('appearance.fonts.custom') },
            ]}
            onChoose={(choice) =>
              changeAppearance({
                uiFont: choice === 'system' || choice === 'custom' ? choice : undefined,
              })
            }
            onFamily={(family) => changeAppearance({ uiFontFamily: family })}
          />
          <FontChoice
            label={t('appearance.fonts.codeLabel')}
            value={appearance.codeFont ?? 'default'}
            family={appearance.codeFontFamily}
            sample={codeFontStack(appearance) ?? DEFAULT_CODE_STACK}
            options={[
              { id: 'default', label: t('appearance.fonts.cascadia') },
              { id: 'cascadia-mono', label: 'Cascadia Mono' },
              { id: 'consolas', label: 'Consolas' },
              { id: 'custom', label: t('appearance.fonts.custom') },
            ]}
            onChoose={(choice) =>
              changeAppearance({
                codeFont:
                  choice === 'cascadia-mono' || choice === 'consolas' || choice === 'custom'
                    ? choice
                    : undefined,
              })
            }
            onFamily={(family) => changeAppearance({ codeFontFamily: family })}
          />
        </div>
      </div>
      <div className="appearance-section">
        <div>
          <h3>{t('appearance.textSize.title')}</h3>
          <p>{t('appearance.textSize.body')}</p>
          <p>{t('appearance.textSize.shortcut')}</p>
        </div>
        <fieldset
          className="appearance-modes appearance-sizes"
          aria-label={t('appearance.textSize.title')}
        >
          {[textSizes[0], undefined, ...textSizes.slice(1)].map((size) => (
            <button
              type="button"
              key={size ?? 100}
              aria-pressed={appearance.textSize === size}
              onClick={() => changeAppearance({ textSize: size })}
            >
              <span>{t('appearance.textSize.percent', { n: size ?? 100 })}</span>
              {appearance.textSize === size && <Check size={13} />}
            </button>
          ))}
        </fieldset>
      </div>
      <div className="appearance-section">
        <div>
          <h3>{t('appearance.ligatures.title')}</h3>
          <p>{t('appearance.ligatures.body')}</p>
        </div>
        <fieldset className="appearance-modes" aria-label={t('appearance.ligatures.title')}>
          {(
            [
              { id: undefined, label: t('appearance.ligatures.on') },
              { id: 'off', label: t('appearance.ligatures.off') },
            ] as const
          ).map(({ id, label }) => (
            <button
              type="button"
              key={label}
              aria-pressed={appearance.ligatures === id}
              onClick={() => changeAppearance({ ligatures: id })}
            >
              <span>{label}</span>
              {appearance.ligatures === id && <Check size={13} />}
            </button>
          ))}
        </fieldset>
      </div>
    </>
  );
}
