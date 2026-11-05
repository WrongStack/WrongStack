import { type InputHTMLAttributes, type ReactNode, useId, useMemo } from 'react';

/** IANA names this system knows; `UTC` first, since some engines leave it out of the list. */
function timeZones(): string[] {
  try {
    const zones = Intl.supportedValuesOf('timeZone');
    return zones.includes('UTC') ? zones : ['UTC', ...zones];
  } catch {
    return ['UTC'];
  }
}

const knownZone = (value: string): boolean => {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: value });
    return true;
  } catch {
    return false;
  }
};

/**
 * A time zone picked from the IANA names or typed. Free text stays accepted (a zone saved on
 * another host may be missing here); a name this system cannot read is marked invalid.
 */
export function TimeZoneInput({
  label,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode; value: string }) {
  const id = useId();
  const zones = useMemo(timeZones, []);
  return (
    <label>
      {label}
      <input
        {...props}
        list={id}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={props.value.trim() && !knownZone(props.value.trim()) ? true : undefined}
      />
      <datalist id={id}>
        {zones.map((zone) => (
          <option key={zone} value={zone} />
        ))}
      </datalist>
    </label>
  );
}
