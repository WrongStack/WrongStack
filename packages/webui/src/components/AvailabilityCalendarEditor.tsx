import type { ModelBlackoutRule } from '@wrongstack/core/models';
import { Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { ModelCandidate } from '@/hooks/useProviderModels';
import {
  CALENDAR_DAYS as DAYS,
  isCalendarRuleActive,
  isCalendarRuleValid,
} from '@/lib/model-calendar';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { useAppTranslation } from '@/i18n';

function logicalTarget(provider: string, model: string) {
  if (provider !== 'omniroute') return { providerId: provider, model };
  const slash = model.indexOf('/');
  return slash > 0
    ? { providerId: model.slice(0, slash), model: model.slice(slash + 1) }
    : { providerId: provider, model };
}

export function AvailabilityCalendarEditor({
  value,
  candidates,
  onChange,
}: {
  value: ModelBlackoutRule[];
  candidates: ModelCandidate[];
  onChange: (rules: ModelBlackoutRule[]) => void;
}) {
  const { t } = useAppTranslation();
  const options = useMemo(() => {
    const refs = candidates.map((candidate) => {
      const logical = logicalTarget(candidate.provider, candidate.model);
      return `${logical.providerId}/${logical.model}`;
    });
    return [...new Set(refs)].sort();
  }, [candidates]);
  const [target, setTarget] = useState(options[0] ?? '');
  const [providerWide, setProviderWide] = useState(false);
  const [mode, setMode] = useState<'blackout' | 'allow_only'>('blackout');
  const [days, setDays] = useState<number[]>([0, 1, 2, 3, 4, 5, 6]);
  const [start, setStart] = useState('00:00');
  const [end, setEnd] = useState('08:00');
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  useEffect(() => {
    if (!target && options[0]) setTarget(options[0]);
  }, [options, target]);

  const patchRule = (index: number, patch: Partial<ModelBlackoutRule>) =>
    onChange(value.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)));

  const toggleRuleDay = (index: number, day: number) => {
    const current = value[index]?.days ?? [];
    patchRule(index, {
      days: current.includes(day)
        ? current.filter((item) => item !== day)
        : [...current, day].sort(),
    });
  };

  const add = () => {
    const slash = target.indexOf('/');
    if (slash <= 0) return;
    const provider = target.slice(0, slash);
    const model = target.slice(slash + 1);
    onChange([
      ...value,
      {
        id: `calendar-${Date.now().toString(36)}`,
        provider,
        ...(providerWide ? {} : { model }),
        days,
        start,
        end,
        timezone,
        enabled: true,
        mode,
        label: providerWide
          ? `${provider} availability schedule`
          : `${target} availability schedule`,
      },
    ]);
  };

  return (
    <div className="space-y-3">
      {value.map((rule, index) => (
        <div key={rule.id} className="space-y-2 rounded-md border bg-muted/30 p-2 text-xs">
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={rule.enabled !== false}
              onChange={(event) => patchRule(index, { enabled: event.target.checked })}
            />
            <code className="min-w-0 flex-1 truncate">
              {rule.provider}/{rule.model ?? '*'}
            </code>
            <span
              className={
                !isCalendarRuleValid(rule)
                  ? 'text-destructive'
                  : isCalendarRuleActive(rule)
                    ? 'text-info'
                    : 'text-muted-foreground'
              }
            >
              {!isCalendarRuleValid(rule)
                ? 'invalid schedule'
                : isCalendarRuleActive(rule)
                  ? 'window active'
                  : 'window inactive'}
            </span>
            <button type="button" onClick={() => onChange(value.filter((_, i) => i !== index))}>
              <Trash2 className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" />
            </button>
          </div>
          <div className="flex flex-wrap gap-1">
            {DAYS.map((day, dayIndex) => (
              <button
                key={day}
                type="button"
                onClick={() => toggleRuleDay(index, dayIndex)}
                className={`rounded px-2 py-1 ${rule.days?.includes(dayIndex) ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}
              >
                {day}
              </button>
            ))}
          </div>
          <div className="grid gap-2 sm:grid-cols-[1fr_1fr_2fr]">
            <Input
              type="time"
              value={rule.start}
              onChange={(event) => patchRule(index, { start: event.target.value })}
            />
            <Input
              type="time"
              value={rule.end}
              onChange={(event) => patchRule(index, { end: event.target.value })}
            />
            <Input
              value={rule.timezone ?? timezone}
              onChange={(event) => patchRule(index, { timezone: event.target.value })}
              placeholder={t('activity:availability.europeKiev')}
            />
          </div>
          <select
            value={rule.mode ?? 'blackout'}
            onChange={(event) =>
              patchRule(index, { mode: event.target.value as 'blackout' | 'allow_only' })
            }
            className="h-8 rounded-md border bg-background px-2 text-xs"
          >
            <option value="blackout">{t('activity:availability.doNotUseInsideThisWindow')}</option>
            <option value="allow_only">{t('activity:availability.useOnlyInsideThisWindow')}</option>
          </select>
        </div>
      ))}

      <div className="space-y-2 rounded-md border border-dashed p-2">
        <select
          value={target}
          onChange={(event) => setTarget(event.target.value)}
          className="h-9 w-full rounded-md border bg-background px-2 font-mono text-xs"
        >
          {options.map((ref) => (
            <option key={ref} value={ref}>
              {ref}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={providerWide}
            onChange={(event) => setProviderWide(event.target.checked)}
          />
          {t('activity:availability.applyThisScheduleToTheWhole')}
        </label>
        <select
          value={mode}
          onChange={(event) => setMode(event.target.value as 'blackout' | 'allow_only')}
          className="h-9 w-full rounded-md border bg-background px-2 text-xs"
        >
          <option value="blackout">{t('activity:availability.doNotUseDuringSelectedTimes')}</option>
          <option value="allow_only">
            {t('activity:availability.useOnlyDuringSelectedTimes')}
          </option>
        </select>
        <div className="flex flex-wrap gap-1">
          {DAYS.map((day, index) => (
            <button
              key={day}
              type="button"
              onClick={() =>
                setDays((current) =>
                  current.includes(index)
                    ? current.filter((item) => item !== index)
                    : [...current, index].sort(),
                )
              }
              className={`rounded px-2 py-1 text-xs ${days.includes(index) ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}
            >
              {day}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Input type="time" value={start} onChange={(event) => setStart(event.target.value)} />
          <span className="text-muted-foreground">to</span>
          <Input type="time" value={end} onChange={(event) => setEnd(event.target.value)} />
          <Button
            type="button"
            variant="outline"
            onClick={add}
            disabled={!target || days.length === 0}
          >
            <Plus className="mr-1 h-3.5 w-3.5" /> {t('activity:availability.addSchedule')}
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Timezone: {timezone}. Overnight windows such as 22:00–07:00 are supported.
        </p>
      </div>
    </div>
  );
}
