import type { ArchitectureDecisionCheck } from '@wrongstack/core/storage';
import { useAppTranslation } from '@/i18n';

export function ArchitectureDecisionChecksEditor({
  checks,
  onChange,
  disabled,
}: {
  checks: ArchitectureDecisionCheck[];
  onChange: (checks: ArchitectureDecisionCheck[]) => void;
  disabled: boolean;
}) {
  const { t } = useAppTranslation();
  const field = 'w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm';
  const update = (index: number, check: ArchitectureDecisionCheck) =>
    onChange(checks.map((current, i) => (i === index ? check : current)));
  const add = () => {
    let number = 1;
    while (checks.some((check) => check.id === `check_${number}`)) number++;
    onChange([...checks, { id: `check_${number}`, path: '', kind: 'file_exists' }]);
  };
  return (
    <fieldset className="space-y-3 rounded-md border border-border p-3" disabled={disabled}>
      <legend className="px-1 text-xs font-semibold">{t('activity:adr.checks.title')}</legend>
      <p className="text-xs text-muted-foreground">{t('activity:adr.checks.help')}</p>
      {checks.map((check, index) => (
        <div key={index} className="space-y-2 border-b border-border pb-3">
          <label className="block text-xs">
            {t('activity:adr.checks.name')}
            <input
              className={field}
              value={check.id}
              maxLength={80}
              required
              onChange={(event) => update(index, { ...check, id: event.target.value })}
            />
          </label>
          <label className="block text-xs">
            {t('activity:adr.checks.path')}
            <input
              className={field}
              value={check.path}
              maxLength={500}
              required
              onChange={(event) => update(index, { ...check, path: event.target.value })}
            />
          </label>
          <label className="block text-xs">
            {t('activity:adr.checks.kind')}
            <select
              aria-label={t('activity:adr.checks.kind')}
              className={field}
              value={check.kind}
              onChange={(event) => {
                const base = { id: check.id, path: check.path };
                const kind = event.target.value as ArchitectureDecisionCheck['kind'];
                update(
                  index,
                  kind === 'file_exists'
                    ? { ...base, kind }
                    : kind === 'json_equals'
                      ? { ...base, kind, pointer: '', value: '' }
                      : { ...base, kind, text: '' },
                );
              }}
            >
              {(['file_exists', 'contains_text', 'excludes_text', 'json_equals'] as const).map(
                (kind) => (
                  <option key={kind} value={kind}>
                    {t(`activity:adr.checks.kinds.${kind}`)}
                  </option>
                ),
              )}
            </select>
          </label>
          {(check.kind === 'contains_text' || check.kind === 'excludes_text') && (
            <label className="block text-xs">
              {t('activity:adr.checks.text')}
              <textarea
                className={field}
                required
                maxLength={2000}
                value={check.text}
                onChange={(event) => update(index, { ...check, text: event.target.value })}
              />
            </label>
          )}
          {check.kind === 'json_equals' && (
            <>
              <label className="block text-xs">
                {t('activity:adr.checks.pointer')}
                <input
                  className={field}
                  maxLength={500}
                  value={check.pointer}
                  placeholder="/packageManager"
                  onChange={(event) => update(index, { ...check, pointer: event.target.value })}
                />
              </label>
              <label className="block text-xs">
                {t('activity:adr.checks.valueType')}
                <select
                  aria-label={t('activity:adr.checks.valueType')}
                  className={field}
                  value={check.value === null ? 'null' : typeof check.value}
                  onChange={(event) =>
                    update(index, {
                      ...check,
                      value:
                        event.target.value === 'null'
                          ? null
                          : event.target.value === 'boolean'
                            ? false
                            : event.target.value === 'number'
                              ? 0
                              : '',
                    })
                  }
                >
                  {['string', 'number', 'boolean', 'null'].map((type) => (
                    <option key={type} value={type}>
                      {t(`activity:adr.checks.types.${type}`)}
                    </option>
                  ))}
                </select>
              </label>
              {check.value !== null &&
                (typeof check.value === 'boolean' ? (
                  <label className="block text-xs">
                    {t('activity:adr.checks.value')}
                    <select
                      aria-label={t('activity:adr.checks.value')}
                      className={field}
                      value={String(check.value)}
                      onChange={(event) =>
                        update(index, { ...check, value: event.target.value === 'true' })
                      }
                    >
                      <option value="true">true</option>
                      <option value="false">false</option>
                    </select>
                  </label>
                ) : (
                  <label className="block text-xs">
                    {t('activity:adr.checks.value')}
                    <input
                      key={typeof check.value}
                      className={field}
                      type={typeof check.value === 'number' ? 'number' : 'text'}
                      step="any"
                      maxLength={2000}
                      required={typeof check.value === 'number'}
                      value={typeof check.value === 'number' ? undefined : check.value}
                      defaultValue={typeof check.value === 'number' ? check.value : undefined}
                      onChange={(event) => {
                        if (typeof check.value === 'number') {
                          if (
                            event.target.value !== '' &&
                            Number.isFinite(event.target.valueAsNumber)
                          )
                            update(index, { ...check, value: event.target.valueAsNumber });
                        } else update(index, { ...check, value: event.target.value });
                      }}
                    />
                  </label>
                ))}
            </>
          )}
          <button
            type="button"
            className="text-xs underline"
            onClick={() => onChange(checks.filter((_, i) => i !== index))}
          >
            {t('activity:adr.checks.remove')}
          </button>
        </div>
      ))}
      <button
        type="button"
        className="rounded-md border border-border px-3 py-2 text-xs"
        disabled={checks.length >= 16}
        onClick={add}
      >
        {t('activity:adr.checks.add')}
      </button>
    </fieldset>
  );
}
