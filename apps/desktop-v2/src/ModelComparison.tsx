import { ArrowLeft } from 'lucide-react';
import { useDesktopText } from './desktop-i18n';
import { comparisonRows } from './model-comparison';
import type { PickerModel } from './model-picker-details';

export interface ComparedModel {
  key: string;
  provider: string;
  model: PickerModel;
}

/**
 * Catalog facts of the compared models side by side, possibly from different providers, with a
 * way to pick one of them (which switches the provider too when needed).
 */
export function ModelComparison({
  models,
  disabled,
  onUse,
  onBack,
}: {
  models: ComparedModel[];
  disabled: boolean;
  onUse: (id: string, provider: string) => void;
  onBack: () => void;
}) {
  const { t } = useDesktopText();
  const rows = comparisonRows(
    models.map((entry) => entry.model),
    {
      context: t('modelCompare.row.context'),
      output: t('modelCompare.row.output'),
      inputPrice: t('modelCompare.row.inputPrice'),
      outputPrice: t('modelCompare.row.outputPrice'),
      status: t('modelCompare.row.status'),
      capabilities: {
        tools: t('modelCompare.cap.tools'),
        reasoning: t('modelCompare.cap.reasoning'),
        vision: t('modelCompare.cap.vision'),
        open_weights: t('modelCompare.cap.openWeights'),
      },
      unknown: t('modelCompare.unknown'),
      yes: t('modelCompare.yes'),
      notReported: t('modelCompare.notReported'),
    },
  );
  return (
    <div className="model-comparison">
      <button type="button" className="button secondary small" onClick={onBack}>
        <ArrowLeft size={13} /> {t('modelCompare.back')}
      </button>
      <div className="model-comparison-scroll">
        <table aria-label={t('modelCompare.label')}>
          <thead>
            <tr>
              <th scope="col">{t('modelCompare.fact')}</th>
              {models.map(({ key, provider, model }) => (
                <th scope="col" key={key}>
                  <strong>{model.name}</strong>
                  <small>{model.id}</small>
                  <small>{provider}</small>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label}>
                <th scope="row">{row.label}</th>
                {row.cells.map((cell, index) => (
                  <td key={models[index]!.key} className={cell.best ? 'best' : undefined}>
                    {cell.text}
                    {cell.best && <small> {t('modelCompare.best')}</small>}
                  </td>
                ))}
              </tr>
            ))}
            <tr>
              <th scope="row">{t('modelCompare.choose')}</th>
              {models.map(({ key, provider, model }) => (
                <td key={key}>
                  <button
                    type="button"
                    className="button small"
                    disabled={disabled}
                    onClick={() => onUse(model.id, provider)}
                  >
                    {t('modelCompare.use', { name: model.name })}
                  </button>
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
      <small className="field-help">{t('modelCompare.note')}</small>
    </div>
  );
}
