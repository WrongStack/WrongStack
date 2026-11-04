import { useAppTranslation } from '../lib/i18n';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import type { MemoryDraft } from './shared';

export function MemoryValidityEditor({
  draft,
  onChange,
}: {
  draft: MemoryDraft;
  onChange: (value: MemoryDraft) => void;
}) {
  const { t } = useAppTranslation();
  const checks = draft.validityChecks ?? [];
  return (
    <section className="space-y-3 rounded border border-border p-3">
      <label className="block text-sm font-semibold" htmlFor="memory-validity">
        {t('activity:memoryValidity.title')}
      </label>
      <textarea
        id="memory-validity"
        className="w-full rounded border border-input bg-background p-2 text-sm"
        rows={3}
        maxLength={1000}
        required={checks.length > 0}
        value={draft.validityStatement ?? ''}
        onChange={(e) => onChange({ ...draft, validityStatement: e.target.value })}
        placeholder={t('activity:memoryValidity.placeholder')}
      />
      <p className="text-xs text-muted-foreground">{t('activity:memoryValidity.unknown')}</p>
      {checks.map((check, index) => (
        <div key={index} className="space-y-2 border-t border-border pt-2">
          <Input
            aria-label={t('activity:memoryValidity.path')}
            placeholder={t('activity:memoryValidity.path')}
            required
            maxLength={500}
            value={check.path}
            onChange={(e) =>
              onChange({
                ...draft,
                validityChecks: checks.map((c, i) =>
                  i === index ? { ...c, path: e.target.value } : c,
                ),
              })
            }
          />
          <Input
            aria-label={t('activity:memoryValidity.literal')}
            placeholder={t('activity:memoryValidity.literal')}
            required
            maxLength={400}
            value={check.text}
            onChange={(e) =>
              onChange({
                ...draft,
                validityChecks: checks.map((c, i) =>
                  i === index ? { ...c, text: e.target.value } : c,
                ),
              })
            }
          />
          <Button
            type="button"
            variant="ghost"
            onClick={() =>
              onChange({ ...draft, validityChecks: checks.filter((_, i) => i !== index) })
            }
          >
            {t('activity:memoryValidity.remove')}
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        disabled={checks.length >= 4}
        onClick={() =>
          onChange({
            ...draft,
            validityChecks: [...checks, { type: 'source_contains', path: '', text: '' }],
          })
        }
      >
        {t('activity:memoryValidity.add')}
      </Button>
    </section>
  );
}
