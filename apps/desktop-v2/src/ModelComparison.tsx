import { ArrowLeft } from 'lucide-react';
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
  const rows = comparisonRows(models.map((entry) => entry.model));
  return (
    <div className="model-comparison">
      <button type="button" className="button secondary small" onClick={onBack}>
        <ArrowLeft size={13} /> Back to models
      </button>
      <div className="model-comparison-scroll">
        <table aria-label="Model comparison">
          <thead>
            <tr>
              <th scope="col">Fact</th>
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
                    {cell.best && <small> best</small>}
                  </td>
                ))}
              </tr>
            ))}
            <tr>
              <th scope="row">Choose</th>
              {models.map(({ key, provider, model }) => (
                <td key={key}>
                  <button
                    type="button"
                    className="button small"
                    disabled={disabled}
                    onClick={() => onUse(model.id, provider)}
                  >
                    Use {model.name}
                  </button>
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
      <small className="field-help">
        Catalog facts as reported by the engine. Unknown values are not estimated; the highlighted
        value is the largest limit or lowest price among known values.
      </small>
    </div>
  );
}
