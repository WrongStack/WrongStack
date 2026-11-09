import { useDesktopText } from './desktop-i18n';
import type { SettingField } from './settings-fields';

/**
 * One profile setting from the field registry: a switch, a select (of words or of numbers), a
 * number in its displayed unit, or a list of lines. A field that may stay unset says what an
 * unset value means instead of reporting it missing. Its words come from the display language's
 * catalog, the registry's English when the catalog has none.
 */
export function SettingRow({
  field,
  value,
  onChange,
  unavailableOptions,
}: {
  field: SettingField;
  value: unknown;
  onChange: (value: unknown) => void;
  /** Select options the engine cannot honor: listed, not choosable, with the reason as tooltip. */
  unavailableOptions?: ReadonlyMap<string, string> | undefined;
}) {
  const { t } = useDesktopText();
  const text = (part: string, english: string) =>
    t(`fields.${field.key}.${part}`, { defaultValue: english });
  const label = text('label', field.label);
  const optionLabel = (option: string) => {
    const own = field.optionLabels?.[option];
    return own
      ? text(`options.${option}`, own)
      : t(`options.${option}`, { defaultValue: option[0]!.toUpperCase() + option.slice(1) });
  };
  const options = field.options ?? [];
  // A numeric select stores a number; show the option that equals it.
  const selected = field.numeric
    ? typeof value === 'number'
      ? (options.find((option) => Number(option) === value) ?? String(value))
      : ''
    : typeof value === 'string'
      ? value
      : '';
  return (
    <div className={`setting-row setting-${field.kind}`}>
      <div>
        <label htmlFor={`setting-${field.key}`}>{label}</label>
        <p>{text('description', field.description)}</p>
        {value === undefined && (
          <small>{field.unsetNote ? text('unset', field.unsetNote) : t('row.unreported')}</small>
        )}
      </div>
      <div className="setting-control">
        {field.kind === 'toggle' ? (
          <button
            type="button"
            id={`setting-${field.key}`}
            role="switch"
            aria-checked={value === true}
            aria-label={label}
            className="settings-switch"
            onClick={() => onChange(value !== true)}
          >
            <span className="settings-switch-thumb" />
          </button>
        ) : field.kind === 'select' ? (
          <select
            id={`setting-${field.key}`}
            value={selected}
            onChange={(event) =>
              onChange(field.numeric ? Number(event.target.value) : event.target.value)
            }
          >
            <option value="" disabled>
              {t('row.choose')}
            </option>
            {[...new Set([...options, ...(selected ? [selected] : [])])].map((option) => (
              <option
                key={option}
                value={option}
                disabled={unavailableOptions?.has(option)}
                title={unavailableOptions?.get(option)}
              >
                {optionLabel(option)}
              </option>
            ))}
          </select>
        ) : field.kind === 'number' ? (
          <span className="settings-number">
            <input
              id={`setting-${field.key}`}
              type="number"
              min={field.min ?? 0}
              max={field.max}
              step={field.scale ? 'any' : undefined}
              required={!field.unsetNote}
              // An empty box that may stay unset reads as the engine's default, not as missing.
              placeholder={field.unsetNote ? t('limitsPolicy.engineDefault') : undefined}
              value={typeof value === 'number' ? value / (field.scale ?? 1) : ''}
              onChange={(event) =>
                onChange(
                  event.target.value === ''
                    ? undefined
                    : field.scale
                      ? Math.round(Number(event.target.value) * field.scale)
                      : Number(event.target.value),
                )
              }
            />
            {field.unit && <span>{t(`units.${field.unit}`, { defaultValue: field.unit })}</span>}
          </span>
        ) : field.kind === 'text' || field.kind === 'secret' ? (
          <input
            id={`setting-${field.key}`}
            type={field.kind === 'secret' ? 'password' : 'text'}
            autoComplete="off"
            spellCheck={false}
            placeholder={field.placeholder && text('placeholder', field.placeholder)}
            pattern={field.pattern}
            required={field.required}
            value={typeof value === 'string' ? value : ''}
            onChange={(event) =>
              // An emptied secret means "keep the saved one": it is never read back to clear.
              onChange(
                field.kind === 'secret' && !event.target.value ? undefined : event.target.value,
              )
            }
          />
        ) : (
          <textarea
            id={`setting-${field.key}`}
            rows={5}
            value={Array.isArray(value) ? value.join('\n') : ''}
            onChange={(event) =>
              onChange(
                event.target.value
                  .split('\n')
                  .map((value) => value.trim())
                  .filter(Boolean),
              )
            }
            placeholder={t('row.lines')}
          />
        )}
      </div>
    </div>
  );
}
