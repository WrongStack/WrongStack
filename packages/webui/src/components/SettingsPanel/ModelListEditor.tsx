/**
 * `<ModelListEditor>` — row-based model editor replacing the comma-separated
 * input for provider model management (ME-4).
 *
 * One row per model showing: id/name, limits, cost, modality badges, capability
 * icons, source badge (catalog/custom/overridden). Add from catalog (server-side
 * search) or add custom. Inline edit opens a grouped schema form. Per-row remove.
 *
 * Wired to the ME-3 WS protocol: provider.custom_models.set/remove.
 */
import {
  Brain,
  Clock,
  DollarSign,
  Eye,
  FileText,
  ImageIcon,
  Mic,
  Pencil,
  Plus,
  Trash2,
  Video,
  Wrench,
  X,
} from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import type { WrongStackWebSocketClient } from '../../lib/ws-client';
import { toast } from '../Toaster';
import { Button } from '../ui/button';
import { ModelCatalogPicker } from './ModelCatalogPicker';
import { ModelSchemaEditor } from './ModelSchemaEditor';

// ── Types ───────────────────────────────────────────────────────────────

export interface ModelRowData {
  modelId: string;
  name?: string | undefined;
  /** Full models.dev payload (ME-2) — may be a delta or a full object. */
  modelsDev?: Record<string, unknown> | undefined;
  /** Legacy derived fields. */
  maxOutput?: number | undefined;
  capabilities?: {
    maxContext?: number | undefined;
    tools?: boolean | undefined;
    vision?: boolean | undefined;
    reasoning?: boolean | undefined;
  } | undefined;
  /** "catalog" = from models.dev, "custom" = user-defined, "overridden" = catalog+user edits. */
  source: 'catalog' | 'custom' | 'overridden';
}

export interface ModelListEditorProps {
  providerId: string;
  models: string[];
  customModels?: Record<string, {
    name?: string | undefined;
    maxOutput?: number | undefined;
    capabilities?: Record<string, unknown> | undefined;
    modelsDev?: Record<string, unknown> | undefined;
  }> | undefined;
  ws: WrongStackWebSocketClient;
}

// ── Helpers ─────────────────────────────────────────────────────────────

function deriveRows(
  models: string[],
  customModels: ModelListEditorProps['customModels'],
): ModelRowData[] {
  return models.map((modelId) => {
    const cm = customModels?.[modelId];
    const md = cm?.modelsDev;
    const hasOverrides = !!(cm && (cm.name || cm.maxOutput || cm.capabilities || md));
    return {
      modelId,
      name: (md?.['name'] as string | undefined) ?? cm?.name ?? modelId,
      modelsDev: md,
      maxOutput: cm?.maxOutput ?? (md?.['limit'] as Record<string, unknown> | undefined)?.['output'] as number | undefined,
      capabilities: cm?.capabilities as ModelRowData['capabilities'],
      source: hasOverrides ? 'overridden' : 'custom',
    };
  });
}

function formatContext(modelsDev?: Record<string, unknown>): string | undefined {
  const limit = modelsDev?.['limit'] as Record<string, unknown> | undefined;
  const ctx = limit?.['context'];
  if (typeof ctx === 'number' && ctx > 0) {
    return ctx >= 1_000_000 ? `${(ctx / 1_000_000).toFixed(1)}M` : `${Math.round(ctx / 1000)}K`;
  }
  return undefined;
}

function formatCost(modelsDev?: Record<string, unknown>): { input?: string; output?: string } {
  const cost = modelsDev?.['cost'] as Record<string, unknown> | undefined;
  const fmt = (v: unknown) => (typeof v === 'number' && v >= 0 ? `$${v}` : undefined);
  return { input: fmt(cost?.['input']), output: fmt(cost?.['output']) };
}

function getModalities(modelsDev?: Record<string, unknown>): { input: string[]; output: string[] } {
  const md = modelsDev?.['modalities'] as Record<string, unknown> | undefined;
  return {
    input: Array.isArray(md?.['input']) ? (md!['input'] as string[]) : [],
    output: Array.isArray(md?.['output']) ? (md!['output'] as string[]) : [],
  };
}

const MODALITY_ICONS: Record<string, typeof Eye> = {
  text: FileText,
  image: ImageIcon,
  audio: Mic,
  video: Video,
  pdf: FileText,
};

// ── Component ───────────────────────────────────────────────────────────

export function ModelListEditor({ providerId, models, customModels, ws }: ModelListEditorProps) {
  const { t } = useAppTranslation();
  const [editingModel, setEditingModel] = useState<string | null>(null);
  const [showCatalogPicker, setShowCatalogPicker] = useState(false);
  const [showCustomEditor, setShowCustomEditor] = useState(false);

  const rows = useMemo(() => deriveRows(models, customModels), [models, customModels]);

  const handleRemove = useCallback(
    (modelId: string) => {
      ws.removeCustomModel(providerId, modelId);
      toast.success(t('settings:providerModels.modelRemoved', { model: modelId }));
    },
    [ws, providerId, t],
  );

  const handleSave = useCallback(
    (modelId: string, modelsDev: Record<string, unknown>) => {
      ws.setCustomModel(providerId, modelId, { modelsDev });
      setEditingModel(null);
      toast.success(t('settings:providerModels.modelSaved', { model: modelId }));
    },
    [ws, providerId, t],
  );

  const handleCatalogSelect = useCallback(
    (modelId: string, modelsDev: Record<string, unknown>) => {
      ws.setCustomModel(providerId, modelId, { modelsDev });
      setShowCatalogPicker(false);
      toast.success(t('settings:providerModels.modelAdded', { model: modelId }));
    },
    [ws, providerId, t],
  );

  return (
    <div className="space-y-3" data-model-list-editor={providerId}>
      {/* Action bar */}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setShowCatalogPicker(true)}
          className="h-8 gap-1.5 text-xs"
        >
          <Plus className="h-3.5 w-3.5" />
          {t('settings:providerModels.addFromCatalog')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setShowCustomEditor(true)}
          className="h-8 gap-1.5 text-xs"
        >
          <Plus className="h-3.5 w-3.5" />
          {t('settings:providerModels.addCustom')}
        </Button>
      </div>

      {/* Model table */}
      {rows.length > 0 ? (
        <div className="overflow-x-auto rounded-lg border border-border/70">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/70 bg-muted/30 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <th className="px-3 py-2 font-medium">{t('settings:providerModels.colModel')}</th>
                <th className="px-3 py-2 font-medium">{t('settings:providerModels.colContext')}</th>
                <th className="px-3 py-2 font-medium">{t('settings:providerModels.colOutput')}</th>
                <th className="px-3 py-2 font-medium">{t('settings:providerModels.colCost')}</th>
                <th className="px-3 py-2 font-medium">{t('settings:providerModels.colModalities')}</th>
                <th className="px-3 py-2 font-medium">{t('settings:providerModels.colCaps')}</th>
                <th className="px-3 py-2 font-medium">{t('settings:providerModels.colSource')}</th>
                <th className="px-3 py-2" aria-label={t('settings:providerModels.colActions')} />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const ctx = formatContext(row.modelsDev);
                const out = row.maxOutput?.toLocaleString() ?? (row.modelsDev?.['limit'] as Record<string, unknown> | undefined)?.['output'] as number | undefined;
                const cost = formatCost(row.modelsDev);
                const mods = getModalities(row.modelsDev);
                const caps = row.capabilities;
                const isEditing = editingModel === row.modelId;
                return (
                  <>
                    <tr
                      key={row.modelId}
                      className="border-b border-border/40 transition-colors hover:bg-muted/20"
                    >
                      <td className="px-3 py-2">
                        <div className="flex flex-col">
                          <span className="font-mono text-xs font-medium text-foreground">
                            {row.modelId}
                          </span>
                          {row.name && row.name !== row.modelId && (
                            <span className="text-[11px] text-muted-foreground">{row.name}</span>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {ctx ? (
                          <span className="inline-flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            {ctx}
                          </span>
                        ) : (
                          <span className="text-muted-foreground/40">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {typeof out === 'number' ? out.toLocaleString() : <span className="text-muted-foreground/40">—</span>}
                      </td>
                      <td className="px-3 py-2 text-xs">
                        {cost.input || cost.output ? (
                          <span className="inline-flex items-center gap-1 text-muted-foreground">
                            <DollarSign className="h-3 w-3" />
                            {cost.input && cost.output ? `${cost.input}/${cost.output}` : cost.input ?? cost.output}
                          </span>
                        ) : (
                          <span className="text-muted-foreground/40">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap gap-1">
                          {mods.input.map((m) => {
                            const Icon = MODALITY_ICONS[m] ?? FileText;
                            return (
                              <span
                                key={`in-${m}`}
                                className="inline-flex items-center gap-0.5 rounded bg-primary/10 px-1 py-0.5 text-[10px] text-primary"
                                title={`input: ${m}`}
                              >
                                <Icon className="h-2.5 w-2.5" />
                                {m}
                              </span>
                            );
                          })}
                          {mods.output.map((m) => (
                            <span
                              key={`out-${m}`}
                              className="inline-flex items-center gap-0.5 rounded bg-secondary/20 px-1 py-0.5 text-[10px] text-secondary-foreground"
                              title={`output: ${m}`}
                            >
                              {m}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex gap-1">
                          {caps?.tools && <Wrench className="h-3.5 w-3.5 text-muted-foreground" aria-label="tools" />}
                          {caps?.reasoning && <Brain className="h-3.5 w-3.5 text-muted-foreground" aria-label="reasoning" />}
                          {caps?.vision && <Eye className="h-3.5 w-3.5 text-muted-foreground" aria-label="vision" />}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={cn(
                            'inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium',
                            row.source === 'custom' && 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
                            row.source === 'catalog' && 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
                            row.source === 'overridden' && 'bg-purple-500/10 text-purple-600 dark:text-purple-400',
                          )}
                        >
                          {row.source}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex justify-end gap-1">
                          <button
                            type="button"
                            onClick={() => setEditingModel(isEditing ? null : row.modelId)}
                            className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                            aria-label={t('settings:providerModels.editModel', { model: row.modelId })}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleRemove(row.modelId)}
                            className="rounded p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                            aria-label={t('settings:providerModels.removeModel', { model: row.modelId })}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                    {isEditing && (
                      <tr key={`${row.modelId}-edit`} className="border-b border-border/40 bg-muted/10">
                        <td colSpan={8} className="p-3">
                          <ModelSchemaEditor
                            providerId={providerId}
                            modelId={row.modelId}
                            initialModelsDev={row.modelsDev ?? {}}
                            onSave={handleSave}
                            onCancel={() => setEditingModel(null)}
                          />
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-border/50 p-8 text-center">
          <p className="text-sm text-muted-foreground">
            {t('settings:providerModels.emptyState')}
          </p>
        </div>
      )}

      {/* Catalog picker modal */}
      {showCatalogPicker && (
        <ModelCatalogPicker
          providerId={providerId}
          ws={ws}
          onSelect={handleCatalogSelect}
          onClose={() => setShowCatalogPicker(false)}
        />
      )}

      {/* Custom model editor modal */}
      {showCustomEditor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setShowCustomEditor(false)}>
          <div className="max-h-[80vh] w-full max-w-2xl overflow-y-auto rounded-lg border border-border bg-background p-4 shadow-lg" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold">
                {t('settings:providerModels.addCustomTitle')}
              </h3>
              <button type="button" onClick={() => setShowCustomEditor(false)} className="text-muted-foreground hover:text-foreground">
                <X className="h-4 w-4" />
              </button>
            </div>
            <ModelSchemaEditor
              providerId={providerId}
              modelId=""
              initialModelsDev={{}}
              onSave={handleSave}
              onCancel={() => setShowCustomEditor(false)}
            />
          </div>
        </div>
      )}
    </div>
  );
}
