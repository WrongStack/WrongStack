import type { SettingField } from './settings-fields';

/**
 * One profile setting from the field registry: a switch, a select (of words or of numbers), a
 * number in its displayed unit, or a list of lines. A field that may stay unset says what an
 * unset value means instead of reporting it missing.
 */
export function SettingRow({
  field,
  value,
  onChange,
}: {
  field: SettingField;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const options = field.options ?? [];
  // A numeric select stores a number; show the option that equals it.
  const selected = field.numeric
    ? typeof value === 'number'
      ? (options.find((option) => Number(option) === value) ?? String(value))
      : ''
    : typeof value === 'string'
      ? value
      : '';
  const labels: Record<string, string> = {
    off: 'Off',
    suggest: 'Suggest next steps',
    auto: 'Automatic',
    eternal: 'Continuous',
    'eternal-parallel': 'Continuous, parallel',
    hybrid: 'Hybrid',
    intelligent: 'Intelligent',
    selective: 'Selective',
    balanced: 'Balanced',
    frugal: 'Frugal',
    deep: 'Deep',
    lite: 'Compact',
    default: 'Default',
    pro: 'Full operating instructions',
    '5m': '5 minutes',
    '1h': '1 hour',
  };
  return (
    <div className={`setting-row setting-${field.kind}`}>
      <div>
        <label htmlFor={`setting-${field.key}`}>{field.label}</label>
        <p>{field.description}</p>
        {value === undefined && <small>{field.unsetNote ?? 'Not reported by this engine'}</small>}
      </div>
      <div className="setting-control">
        {field.kind === 'toggle' ? (
          <button
            type="button"
            id={`setting-${field.key}`}
            role="switch"
            aria-checked={value === true}
            aria-label={field.label}
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
              Choose a value
            </option>
            {[...new Set([...options, ...(selected ? [selected] : [])])].map((option) => (
              <option key={option} value={option}>
                {field.optionLabels?.[option] ??
                  labels[option] ??
                  option[0]!.toUpperCase() + option.slice(1)}
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
            {field.unit && <span>{field.unit}</span>}
          </span>
        ) : field.kind === 'text' || field.kind === 'secret' ? (
          <input
            id={`setting-${field.key}`}
            type={field.kind === 'secret' ? 'password' : 'text'}
            autoComplete="off"
            spellCheck={false}
            placeholder={field.placeholder}
            pattern={field.pattern}
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
            placeholder="One model identifier per line"
          />
        )}
      </div>
    </div>
  );
}
