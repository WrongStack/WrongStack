/**
 * `<ModelSchemaEditor>` — grouped schema edit form for a single model (ME-4).
 *
 * Sections: identity · limits · pricing · modalities · capability flags · dates.
 * Client-side validation via the ME-1 zod schema (modelsDevModelSchema).
 * Optional raw-JSON advanced tab.
 */

import { MODELS_DEV_MODALITY_VALUES, modelsDevModelSchema } from '@wrongstack/core/models';
import { Check, X } from 'lucide-react';
import { useCallback, useState } from 'react';
import { useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { Button } from '../ui/button';

interface ModelSchemaEditorProps {
  providerId: string;
  modelId: string;
  initialModelsDev: Record<string, unknown>;
  onSave: (modelId: string, modelsDev: Record<string, unknown>) => void;
  onCancel: () => void;
}

export interface FormState {
  id: string;
  name: string;
  description: string;
  family: string;
  limitContext: string;
  limitOutput: string;
  limitInput: string;
  costInput: string;
  costOutput: string;
  inputModalities: string[];
  outputModalities: string[];
  toolCall: boolean;
  reasoning: boolean;
  temperature: boolean;
  attachment: boolean;
  structuredOutput: boolean;
  openWeights: boolean;
  releaseDate: string;
  lastUpdated: string;
  knowledge: string;
}

function toFormState(modelId: string, md: Record<string, unknown>): FormState {
  const limit = md['limit'] as Record<string, unknown> | undefined;
  const cost = md['cost'] as Record<string, unknown> | undefined;
  const mods = md['modalities'] as Record<string, unknown> | undefined;
  return {
    id: modelId,
    name: (md['name'] as string | undefined) ?? '',
    description: (md['description'] as string | undefined) ?? '',
    family: (md['family'] as string | undefined) ?? '',
    limitContext: limit?.['context'] != null ? String(limit['context']) : '',
    limitOutput: limit?.['output'] != null ? String(limit['output']) : '',
    limitInput: limit?.['input'] != null ? String(limit['input']) : '',
    costInput: cost?.['input'] != null ? String(cost['input']) : '',
    costOutput: cost?.['output'] != null ? String(cost['output']) : '',
    inputModalities: Array.isArray(mods?.['input']) ? (mods!['input'] as string[]) : [],
    outputModalities: Array.isArray(mods?.['output']) ? (mods!['output'] as string[]) : [],
    toolCall: md['tool_call'] === true,
    reasoning: md['reasoning'] === true,
    temperature: md['temperature'] === true,
    attachment: md['attachment'] === true,
    structuredOutput: md['structured_output'] === true,
    openWeights: md['open_weights'] === true,
    releaseDate: (md['release_date'] as string | undefined) ?? '',
    lastUpdated: (md['last_updated'] as string | undefined) ?? '',
    knowledge: (md['knowledge'] as string | undefined) ?? '',
  };
}

export function buildPayload(
  fs: FormState,
  initial: Record<string, unknown>,
): Record<string, unknown> {
  // Start from the current modelsDev so fields the form does not edit
  // (reasoning_options, interleaved, status, experimental, cost.cache_*,
  // unknown upstream keys) are preserved instead of silently dropped.
  const out: Record<string, unknown> = { ...initial };

  // Identity — empty strings mean "leave as-is" (delta semantics).
  if (fs.name) out['name'] = fs.name;
  if (fs.description) out['description'] = fs.description;
  if (fs.family) out['family'] = fs.family;
  if (fs.knowledge) out['knowledge'] = fs.knowledge;

  // Limits — deep-merge so untouched sub-fields survive.
  const limit: Record<string, number> = {};
  if (fs.limitContext) {
    const n = Number(fs.limitContext);
    if (Number.isFinite(n) && n >= 0) limit['context'] = n;
  }
  if (fs.limitOutput) {
    const n = Number(fs.limitOutput);
    if (Number.isFinite(n) && n >= 0) limit['output'] = n;
  }
  if (fs.limitInput) {
    const n = Number(fs.limitInput);
    if (Number.isFinite(n) && n >= 0) limit['input'] = n;
  }
  if (Object.keys(limit).length > 0) {
    out['limit'] = {
      ...((initial['limit'] as Record<string, unknown> | undefined) ?? {}),
      ...limit,
    };
  }

  // Pricing — deep-merge so cache_read/cache_write/tiers survive.
  const cost: Record<string, number> = {};
  if (fs.costInput) {
    const n = Number(fs.costInput);
    if (Number.isFinite(n) && n >= 0) cost['input'] = n;
  }
  if (fs.costOutput) {
    const n = Number(fs.costOutput);
    if (Number.isFinite(n) && n >= 0) cost['output'] = n;
  }
  if (Object.keys(cost).length > 0) {
    out['cost'] = { ...((initial['cost'] as Record<string, unknown> | undefined) ?? {}), ...cost };
  }

  const mods: Record<string, string[]> = {};
  if (fs.inputModalities.length > 0) mods['input'] = fs.inputModalities;
  if (fs.outputModalities.length > 0) mods['output'] = fs.outputModalities;
  if (Object.keys(mods).length > 0) {
    out['modalities'] = {
      ...((initial['modalities'] as Record<string, unknown> | undefined) ?? {}),
      ...mods,
    };
  }

  // Capability flags — emit BOTH true and false, but only when the user
  // actually changed the value, so turning OFF a catalog capability persists
  // while untouched flags don't get clobbered into a delta.
  const boolFields: Array<[keyof FormState, string]> = [
    ['toolCall', 'tool_call'],
    ['reasoning', 'reasoning'],
    ['temperature', 'temperature'],
    ['attachment', 'attachment'],
    ['structuredOutput', 'structured_output'],
    ['openWeights', 'open_weights'],
  ];
  for (const [field, key] of boolFields) {
    const initialValue = initial[key] === true;
    if (fs[field] !== initialValue) out[key] = fs[field];
  }

  if (fs.releaseDate) out['release_date'] = fs.releaseDate;
  if (fs.lastUpdated) out['last_updated'] = fs.lastUpdated;

  return out;
}

const CAPABILITY_FIELDS: Array<{ key: keyof FormState; labelKey: string }> = [
  { key: 'toolCall', labelKey: 'settings:modelSchema.capToolCall' },
  { key: 'reasoning', labelKey: 'settings:modelSchema.capReasoning' },
  { key: 'temperature', labelKey: 'settings:modelSchema.capTemperature' },
  { key: 'attachment', labelKey: 'settings:modelSchema.capAttachment' },
  { key: 'structuredOutput', labelKey: 'settings:modelSchema.capStructuredOutput' },
  { key: 'openWeights', labelKey: 'settings:modelSchema.capOpenWeights' },
];

export function ModelSchemaEditor({
  providerId: _providerId,
  modelId,
  initialModelsDev,
  onSave,
  onCancel,
}: ModelSchemaEditorProps) {
  const { t } = useAppTranslation();
  const [showRaw, setShowRaw] = useState(false);
  const [form, setForm] = useState<FormState>(() => toFormState(modelId, initialModelsDev));
  const [errors, setErrors] = useState<string[]>([]);
  const [rawText, setRawText] = useState(
    JSON.stringify({ ...initialModelsDev, ...(modelId ? { id: modelId } : {}) }, null, 2),
  );
  const [rawError, setRawError] = useState<string | null>(null);

  const update = useCallback(<K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  }, []);

  const toggleModality = useCallback(
    (direction: 'inputModalities' | 'outputModalities', value: string) => {
      setForm((prev) => {
        const current = prev[direction];
        return {
          ...prev,
          [direction]: current.includes(value)
            ? current.filter((v) => v !== value)
            : [...current, value],
        };
      });
    },
    [],
  );

  const handleFormSave = useCallback(() => {
    const payload = buildPayload(form, initialModelsDev);
    const result = modelsDevModelSchema.safeParse({ ...payload, id: form.id || modelId });
    if (!result.success) {
      setErrors(result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
      return;
    }
    setErrors([]);
    onSave(form.id || modelId, payload);
  }, [form, initialModelsDev, modelId, onSave]);

  const handleRawSave = useCallback(() => {
    try {
      const parsed = JSON.parse(rawText);
      const result = modelsDevModelSchema.safeParse({ ...parsed, id: modelId || parsed.id });
      if (!result.success) {
        setRawError(result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
        return;
      }
      const { id: _id, ...rest } = result.data;
      setRawError(null);
      onSave(modelId || result.data.id, rest as Record<string, unknown>);
    } catch (err) {
      setRawError(err instanceof Error ? err.message : String(err));
    }
  }, [rawText, modelId, onSave]);

  const inputStyle =
    'h-8 w-full rounded-md border border-border bg-background px-2.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring';
  const labelStyle =
    'mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground';

  return (
    <div className="space-y-4">
      {/* Tab switch */}
      <div className="flex gap-1 border-b border-border/50">
        <button
          type="button"
          onClick={() => setShowRaw(false)}
          className={cn(
            'border-b-2 px-3 py-1 text-xs font-medium transition-colors',
            !showRaw
              ? 'border-primary text-primary'
              : 'border-transparent text-muted-foreground hover:text-foreground',
          )}
        >
          {t('settings:providerModels.tabForm')}
        </button>
        <button
          type="button"
          onClick={() => setShowRaw(true)}
          className={cn(
            'border-b-2 px-3 py-1 text-xs font-medium transition-colors',
            showRaw
              ? 'border-primary text-primary'
              : 'border-transparent text-muted-foreground hover:text-foreground',
          )}
        >
          {t('settings:providerModels.tabRawJson')}
        </button>
      </div>

      {!showRaw ? (
        <>
          {/* Identity */}
          <fieldset className="space-y-2">
            <legend className="text-xs font-semibold text-foreground">
              {t('settings:providerModels.sectionIdentity')}
            </legend>
            {!modelId && (
              <div>
                <label className={labelStyle} htmlFor="mse-id">
                  ID
                </label>
                <input
                  id="mse-id"
                  className={inputStyle}
                  value={form.id}
                  onChange={(e) => update('id', e.target.value)}
                  placeholder={t('activity:modelSchema.modelId')}
                />
              </div>
            )}
            <div>
              <label className={labelStyle} htmlFor="mse-name">
                {t('settings:providerModels.fieldName')}
              </label>
              <input
                id="mse-name"
                className={inputStyle}
                value={form.name}
                onChange={(e) => update('name', e.target.value)}
              />
            </div>
            <div>
              <label className={labelStyle} htmlFor="mse-desc">
                {t('settings:providerModels.fieldDescription')}
              </label>
              <input
                id="mse-desc"
                className={inputStyle}
                value={form.description}
                onChange={(e) => update('description', e.target.value)}
              />
            </div>
            <div>
              <label className={labelStyle} htmlFor="mse-family">
                {t('settings:providerModels.fieldFamily')}
              </label>
              <input
                id="mse-family"
                className={inputStyle}
                value={form.family}
                onChange={(e) => update('family', e.target.value)}
              />
            </div>
          </fieldset>

          {/* Limits */}
          <fieldset className="space-y-2">
            <legend className="text-xs font-semibold text-foreground">
              {t('settings:providerModels.sectionLimits')}
            </legend>
            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className={labelStyle} htmlFor="mse-ctx">
                  {t('settings:providerModels.fieldContext')}
                </label>
                <input
                  id="mse-ctx"
                  type="number"
                  className={inputStyle}
                  value={form.limitContext}
                  onChange={(e) => update('limitContext', e.target.value)}
                />
              </div>
              <div>
                <label className={labelStyle} htmlFor="mse-out">
                  {t('settings:providerModels.fieldOutput')}
                </label>
                <input
                  id="mse-out"
                  type="number"
                  className={inputStyle}
                  value={form.limitOutput}
                  onChange={(e) => update('limitOutput', e.target.value)}
                />
              </div>
              <div>
                <label className={labelStyle} htmlFor="mse-inlim">
                  {t('settings:providerModels.fieldInputLimit')}
                </label>
                <input
                  id="mse-inlim"
                  type="number"
                  className={inputStyle}
                  value={form.limitInput}
                  onChange={(e) => update('limitInput', e.target.value)}
                />
              </div>
            </div>
          </fieldset>

          {/* Pricing */}
          <fieldset className="space-y-2">
            <legend className="text-xs font-semibold text-foreground">
              {t('settings:providerModels.sectionPricing')}
            </legend>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className={labelStyle} htmlFor="mse-costin">
                  {t('settings:providerModels.fieldCostInput')}
                </label>
                <input
                  id="mse-costin"
                  type="number"
                  step="0.01"
                  className={inputStyle}
                  value={form.costInput}
                  onChange={(e) => update('costInput', e.target.value)}
                />
              </div>
              <div>
                <label className={labelStyle} htmlFor="mse-costout">
                  {t('settings:providerModels.fieldCostOutput')}
                </label>
                <input
                  id="mse-costout"
                  type="number"
                  step="0.01"
                  className={inputStyle}
                  value={form.costOutput}
                  onChange={(e) => update('costOutput', e.target.value)}
                />
              </div>
            </div>
          </fieldset>

          {/* Modalities */}
          <fieldset className="space-y-2">
            <legend className="text-xs font-semibold text-foreground">
              {t('settings:providerModels.sectionModalities')}
            </legend>
            <div>
              <span className={labelStyle}>
                {t('settings:providerModels.fieldInputModalities')}
              </span>
              <div className="flex flex-wrap gap-1.5">
                {MODELS_DEV_MODALITY_VALUES.map((m) => {
                  const active = form.inputModalities.includes(m);
                  return (
                    <button
                      key={`in-mod-${m}`}
                      type="button"
                      onClick={() => toggleModality('inputModalities', m)}
                      className={cn(
                        'rounded-md border px-2 py-1 text-xs transition-colors',
                        active
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-border text-muted-foreground hover:border-primary/30',
                      )}
                    >
                      {m}
                    </button>
                  );
                })}
              </div>
            </div>
            <div>
              <span className={labelStyle}>
                {t('settings:providerModels.fieldOutputModalities')}
              </span>
              <div className="flex flex-wrap gap-1.5">
                {MODELS_DEV_MODALITY_VALUES.map((m) => {
                  const active = form.outputModalities.includes(m);
                  return (
                    <button
                      key={`out-mod-${m}`}
                      type="button"
                      onClick={() => toggleModality('outputModalities', m)}
                      className={cn(
                        'rounded-md border px-2 py-1 text-xs transition-colors',
                        active
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-border text-muted-foreground hover:border-primary/30',
                      )}
                    >
                      {m}
                    </button>
                  );
                })}
              </div>
            </div>
          </fieldset>

          {/* Capability flags */}
          <fieldset className="space-y-2">
            <legend className="text-xs font-semibold text-foreground">
              {t('settings:providerModels.sectionCapabilities')}
            </legend>
            <div className="grid grid-cols-2 gap-2">
              {CAPABILITY_FIELDS.map(({ key, labelKey }) => (
                <label key={String(key)} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-border"
                    checked={form[key] as boolean}
                    onChange={(e) => update(key, e.target.checked as never)}
                  />
                  {t(labelKey)}
                </label>
              ))}
            </div>
          </fieldset>

          {/* Dates */}
          <fieldset className="space-y-2">
            <legend className="text-xs font-semibold text-foreground">
              {t('settings:providerModels.sectionDates')}
            </legend>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className={labelStyle} htmlFor="mse-release">
                  {t('settings:providerModels.fieldReleaseDate')}
                </label>
                <input
                  id="mse-release"
                  type="date"
                  className={inputStyle}
                  value={form.releaseDate}
                  onChange={(e) => update('releaseDate', e.target.value)}
                />
              </div>
              <div>
                <label className={labelStyle} htmlFor="mse-updated">
                  {t('settings:providerModels.fieldLastUpdated')}
                </label>
                <input
                  id="mse-updated"
                  type="date"
                  className={inputStyle}
                  value={form.lastUpdated}
                  onChange={(e) => update('lastUpdated', e.target.value)}
                />
              </div>
            </div>
          </fieldset>

          {/* Validation errors */}
          {errors.length > 0 && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 p-2">
              <ul className="space-y-0.5 text-xs text-destructive">
                {errors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </div>
          )}
        </>
      ) : (
        /* Raw JSON tab */
        <div className="space-y-2">
          <textarea
            value={rawText}
            onChange={(e) => setRawText(e.target.value)}
            rows={16}
            className="w-full rounded-md border border-border bg-muted/20 p-2 font-mono text-xs"
            spellCheck={false}
          />
          {rawError && <p className="text-xs text-destructive">{rawError}</p>}
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center justify-end gap-2 border-t border-border/50 pt-3">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onCancel}
          className="h-8 gap-1.5 text-xs"
        >
          <X className="h-3.5 w-3.5" />
          {t('common:action.cancel')}
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={showRaw ? handleRawSave : handleFormSave}
          className="h-8 gap-1.5 text-xs"
        >
          <Check className="h-3.5 w-3.5" />
          {t('common:action.save')}
        </Button>
      </div>
    </div>
  );
}
