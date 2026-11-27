import { Check, ChevronDown, LoaderCircle, X } from 'lucide-react';
import {
  Fragment,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import { useDesktopText } from './desktop-i18n';
import { filterOptions, type ComboboxOption } from './model-reference-options';
import './catalog-combobox.css';

export interface CatalogComboboxProps {
  id?: string;
  /** Accessible name; required because a visible label may lean on a heading. */
  name: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly ComboboxOption[];
  placeholder?: string;
  loading?: boolean;
  disabled?: boolean;
  required?: boolean;
  /** Shown under the field while the value is not one of the options. */
  customText?: string;
  /** A clear button appears beside a non-empty value when its label is given. */
  clearLabel?: string;
  describedBy?: string;
}

/** The list scrolls under the open field; nothing else about the page moves. */
const preventFocusLoss = (event: PointerEvent) => event.preventDefault();

/**
 * A searchable, free-text picker over a catalog. The box holds the stored value or its
 * display name; focusing opens the choices grouped under their headings, typing narrows
 * them by every word, and arrows, Enter and Escape move, pick and close without submitting
 * the surrounding form. A value outside the catalog stays as typed.
 */
export function CatalogCombobox({
  id: givenId,
  name,
  value,
  onChange,
  options,
  placeholder,
  loading = false,
  disabled = false,
  required = false,
  customText = '',
  clearLabel,
  describedBy,
}: CatalogComboboxProps) {
  const { t } = useDesktopText();
  const generated = useId();
  const id = givenId ?? `catalog-combobox-${generated}`;
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  // While open, the box shows `text`; the list narrows by `filter`. A browse keeps the value
  // in the box and shows everything.
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(value);
  const [filter, setFilter] = useState('');
  const [active, setActive] = useState(-1);
  const shown = open ? filterOptions(options, filter) : [];
  const selected = value === '' ? undefined : options.find((option) => option.value === value);
  const idle = selected ? (selected.display ?? selected.label) : value;
  const caption = loading
    ? t('catalogPicker.loading')
    : selected
      ? (selected.hint ?? '')
      : value.trim()
        ? customText
        : '';
  const close = () => setOpen(false);
  const browse = () => {
    setText(value);
    setFilter('');
    setActive(options.findIndex((option) => option.value === value));
    setOpen(true);
    input.current?.focus();
  };
  const pick = (next: string) => {
    onChange(next);
    close();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (!open) browse();
      else setActive((index) => Math.min(index + 1, shown.length - 1));
    } else if (event.key === 'ArrowUp' && open) {
      event.preventDefault();
      setActive((index) => Math.max(index - 1, 0));
    } else if ((event.key === 'Home' || event.key === 'End') && open && shown.length) {
      event.preventDefault();
      setActive(event.key === 'Home' ? 0 : shown.length - 1);
    } else if (event.key === 'Enter' && open) {
      // Enter picks; it must not also submit the settings form around the field.
      event.preventDefault();
      pick(shown[active]?.value ?? value);
    } else if (event.key === 'Escape' && open) {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === 'Tab') close();
  };
  useEffect(() => {
    if (!open) return;
    const outside = (event: globalThis.PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) close();
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  useEffect(() => {
    if (open && active >= 0)
      document.getElementById(`${id}-option-${active}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [id, open, active]);
  return (
    <div className="catalog-combobox" ref={root}>
      <div className="catalog-combobox-control">
        <input
          ref={input}
          id={id}
          type="text"
          role="combobox"
          aria-label={name}
          aria-expanded={open}
          aria-controls={`${id}-listbox`}
          aria-autocomplete="list"
          aria-activedescendant={open && active >= 0 ? `${id}-option-${active}` : undefined}
          aria-describedby={
            [describedBy, caption ? `${id}-caption` : ''].filter(Boolean).join(' ') || undefined
          }
          autoComplete="off"
          spellCheck={false}
          placeholder={placeholder}
          disabled={disabled}
          required={required}
          value={open ? text : idle}
          onFocus={() => {
            if (open) return;
            setText(value);
            setFilter('');
            setActive(options.findIndex((option) => option.value === value));
            setOpen(true);
          }}
          onChange={(event) => {
            const next = event.target.value;
            setText(next);
            setFilter(next);
            setActive(filterOptions(options, next).length ? 0 : -1);
            onChange(next);
          }}
          onBlur={close}
          onKeyDown={onKeyDown}
        />
        {clearLabel && value && !disabled && (
          <button
            type="button"
            className="catalog-combobox-button is-clear"
            tabIndex={-1}
            aria-label={clearLabel}
            title={clearLabel}
            onPointerDown={preventFocusLoss}
            onClick={() => {
              onChange('');
              setText('');
              setFilter('');
              setActive(-1);
              input.current?.focus();
            }}
          >
            <X size={14} aria-hidden="true" />
          </button>
        )}
        <button
          type="button"
          className="catalog-combobox-button is-chevron"
          tabIndex={-1}
          disabled={disabled}
          aria-label={t('catalogPicker.showOptions')}
          title={t('catalogPicker.showOptions')}
          aria-expanded={open}
          onPointerDown={preventFocusLoss}
          onClick={() => (open ? close() : browse())}
        >
          <ChevronDown size={15} aria-hidden="true" className={open ? 'is-open' : undefined} />
        </button>
      </div>
      {open && (
        <div className="catalog-combobox-popup" id={`${id}-listbox`}>
          {loading ? (
            <p role="status">
              <LoaderCircle size={14} className="spin" aria-hidden="true" />{' '}
              {t('catalogPicker.loading')}
            </p>
          ) : !shown.length ? (
            <p>
              {options.length
                ? t('catalogPicker.noMatch', { query: filter })
                : t('catalogPicker.empty')}
            </p>
          ) : (
            <div role="listbox" aria-label={name}>
              {shown.map((option, index) => (
                <Fragment key={option.value}>
                  {option.group && option.group !== shown[index - 1]?.group && (
                    <div className="catalog-combobox-group" role="presentation">
                      {option.group}
                    </div>
                  )}
                  <button
                    type="button"
                    role="option"
                    tabIndex={-1}
                    id={`${id}-option-${index}`}
                    aria-selected={index === active}
                    className="catalog-combobox-option"
                    onPointerDown={preventFocusLoss}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => pick(option.value)}
                  >
                    <span className="catalog-combobox-option-copy">
                      <strong>{option.label}</strong>
                      {option.hint && <small>{option.hint}</small>}
                    </span>
                    {option.value === value && <Check size={14} aria-hidden="true" />}
                  </button>
                </Fragment>
              ))}
            </div>
          )}
        </div>
      )}
      {caption && (
        <small id={`${id}-caption`} className="catalog-combobox-caption">
          {caption}
        </small>
      )}
    </div>
  );
}
