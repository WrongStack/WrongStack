import type { ModelBlackoutRule } from '@wrongstack/contracts/types/model-availability';
import { CalendarDays, Plus, Trash2 } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { availabilityIssue, scheduleDays, scheduleSegments } from './availability-model';
import { availabilityWords } from './availability-words';
import { useDesktopText } from './desktop-i18n';
import { entries } from './engine-values';
import type { PolicyProps } from './ModelPolicySettings';

export function AvailabilitySettings({ draft, change, command }: PolicyProps) {
  const { t } = useDesktopText();
  const rules = (
    Array.isArray(draft['modelAvailabilitySchedule']) ? draft['modelAvailabilitySchedule'] : []
  ) as ModelBlackoutRule[];
  const [catalog, setCatalog] = useState<Record<string, string[]>>({}),
    [catalogError, setCatalogError] = useState('');
  const prefix = useId();
  useEffect(() => {
    let active = true;
    void command('providers.saved', {}, ['providers.saved', 'key.operation_result'])
      .then(async (saved) => {
        const results = await Promise.allSettled(
          entries(saved['providers']).map(async (p) => {
            const id = String(p['id']);
            const result = await command('provider.models', { providerId: id }, [
              'provider.models',
              'key.operation_result',
            ]);
            return [id, entries(result['models']).map((model) => String(model['id']))] as const;
          }),
        );
        if (active) {
          setCatalog(
            Object.fromEntries(
              results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : [])),
            ),
          );
          if (results.some((result) => result.status === 'rejected'))
            setCatalogError(t('availability.catalogError'));
        }
      })
      .catch((e) => {
        if (active) setCatalogError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      active = false;
    };
  }, [command, t]);
  const patch = (id: string, values: Partial<ModelBlackoutRule>) =>
    change(
      'modelAvailabilitySchedule',
      rules.map((rule) => (rule.id === id ? { ...rule, ...values } : rule)),
    );
  const add = () =>
    change('modelAvailabilitySchedule', [
      ...rules,
      {
        id: crypto.randomUUID(),
        label: t('availability.newWindow'),
        enabled: false,
        start: '00:00',
        end: '08:00',
        days: [],
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        mode: 'blackout',
      } satisfies ModelBlackoutRule,
    ]);
  const issue = availabilityIssue(rules, availabilityWords(t));
  return (
    <div className="availability-settings model-policy-settings">
      <div className="settings-defaults-note">{t('availability.intro')}</div>
      <datalist id={prefix + 'providers'}>
        {Object.keys(catalog).map((id) => (
          <option key={id} value={id} />
        ))}
      </datalist>
      {catalogError && <p className="field-help">{catalogError}</p>}
      <button type="button" className="button secondary" onClick={add}>
        <Plus size={14} />
        {t('availability.add')}
      </button>
      {!rules.length && (
        <div className="availability-empty">
          <CalendarDays size={30} />
          <h3>{t('availability.emptyTitle')}</h3>
          <p>{t('availability.emptyBody')}</p>
        </div>
      )}
      {rules.map((rule, index) => {
        const name = t('availability.window', { number: index + 1 }),
          everyDay = !rule.days?.length;
        return (
          <article className="availability-card policy-profile" key={rule.id} aria-label={name}>
            <header>
              <div>
                <span className="eyebrow">
                  {rule.enabled === false ? t('availability.disabled') : t('availability.enabled')}{' '}
                  ·{' '}
                  {rule.mode === 'allow_only'
                    ? t('availability.allowWindow')
                    : t('availability.blackoutWindow')}
                </span>
                <h3>{rule.label || name}</h3>
              </div>
              <button
                type="button"
                className="icon-button danger"
                aria-label={t('availability.remove', { name })}
                onClick={() =>
                  change(
                    'modelAvailabilitySchedule',
                    rules.filter((item) => item.id !== rule.id),
                  )
                }
              >
                <Trash2 size={15} />
              </button>
            </header>
            <label className="policy-toggle">
              <input
                type="checkbox"
                aria-label={t('availability.enabledLabel', { name })}
                checked={rule.enabled !== false}
                onChange={(e) => patch(rule.id, { enabled: e.target.checked })}
              />
              {t('availability.enable')}
            </label>
            <label>
              {t('availability.labelLabel', { name })}
              <input
                aria-label={t('availability.labelLabel', { name })}
                value={rule.label ?? ''}
                onChange={(e) => patch(rule.id, { label: e.target.value })}
              />
            </label>
            <div className="policy-field-grid">
              <label>
                {t('availability.provider')}
                <input
                  aria-label={t('availability.providerLabel', { name })}
                  list={prefix + 'providers'}
                  required={!rule.model?.trim()}
                  value={rule.provider ?? ''}
                  onChange={(e) => patch(rule.id, { provider: e.target.value || undefined })}
                />
              </label>
              <label>
                {t('availability.model')}
                <input
                  aria-label={t('availability.modelLabel', { name })}
                  list={prefix + rule.id}
                  required={!rule.provider?.trim()}
                  value={rule.model ?? ''}
                  onChange={(e) => patch(rule.id, { model: e.target.value || undefined })}
                />
              </label>
              <datalist id={prefix + rule.id}>
                {(catalog[rule.provider ?? ''] ?? []).map((model) => (
                  <option key={model} value={model} />
                ))}
              </datalist>
            </div>
            <label>
              {t('availability.behavior')}
              <select
                aria-label={t('availability.behaviorLabel', { name })}
                value={rule.mode ?? 'blackout'}
                onChange={(e) =>
                  patch(rule.id, { mode: e.target.value as 'blackout' | 'allow_only' })
                }
              >
                <option value="blackout">{t('availability.mode.blackout')}</option>
                <option value="allow_only">{t('availability.mode.allow_only')}</option>
              </select>
            </label>
            <div className="policy-field-grid">
              <label>
                {t('availability.starts')}
                <input
                  aria-label={t('availability.startLabel', { name })}
                  type="time"
                  required
                  value={rule.start}
                  onChange={(e) => patch(rule.id, { start: e.target.value })}
                />
              </label>
              <label>
                {t('availability.ends')}
                <input
                  aria-label={t('availability.endLabel', { name })}
                  type="time"
                  required
                  value={rule.end}
                  onChange={(e) => patch(rule.id, { end: e.target.value })}
                />
              </label>
              <label>
                {t('availability.timezone')}
                <input
                  aria-label={t('availability.timezoneLabel', { name })}
                  value={rule.timezone ?? ''}
                  placeholder={t('availability.hostTimezone')}
                  onChange={(e) => patch(rule.id, { timezone: e.target.value || undefined })}
                />
              </label>
            </div>
            <label className="policy-toggle">
              <input
                type="checkbox"
                aria-label={t('availability.everyDayLabel', { name })}
                checked={everyDay}
                onChange={(e) =>
                  patch(rule.id, { days: e.target.checked ? [] : [0, 1, 2, 3, 4, 5, 6] })
                }
              />
              {t('availability.everyDay')}
            </label>
            <fieldset
              className="schedule-days"
              aria-label={t('availability.weekdays', { name })}
              disabled={everyDay}
            >
              {scheduleDays.map((day, i) => (
                <label key={day}>
                  <input
                    type="checkbox"
                    aria-label={t('availability.dayLabel', {
                      name,
                      day: t(`availability.day.${i}`),
                    })}
                    checked={everyDay || !!rule.days?.includes(i)}
                    disabled={!everyDay && rule.days?.length === 1 && rule.days.includes(i)}
                    onChange={(e) =>
                      patch(rule.id, {
                        days: e.target.checked
                          ? [...(rule.days ?? []), i].sort()
                          : rule.days?.filter((value) => value !== i),
                      })
                    }
                  />
                  {t(`availability.dayShort.${i}`)}
                </label>
              ))}
            </fieldset>
            <section
              className={
                'schedule-week ' + (rule.enabled === false ? 'schedule-week-disabled' : '')
              }
              aria-label={t('availability.previewLabel', { name })}
            >
              <header>
                <span>{t('availability.preview')}</span>
                <span>00:00 · 12:00 · 24:00</span>
              </header>
              {scheduleDays.map((day, i) => (
                <div className="schedule-day-row" key={day}>
                  <span>{t(`availability.dayShort.${i}`)}</span>
                  <div>
                    {scheduleSegments(rule, i).map(([start, end]) => (
                      <i
                        key={start}
                        style={{ left: start / 14.4 + '%', width: (end - start) / 14.4 + '%' }}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </section>
            <p className="field-help">{t('availability.overnightNote')}</p>
          </article>
        );
      })}
      {issue && (
        <p className="field-help" role="status">
          {issue}
        </p>
      )}
    </div>
  );
}
