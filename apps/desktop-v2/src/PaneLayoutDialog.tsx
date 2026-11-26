import { X } from 'lucide-react';
import { Modal } from './Modal';
import {
  defaultPaneLayout,
  type PaneLayout,
  paneBounds,
  paneIds,
  paneLabels,
  panePresets,
} from './pane-layout';
import { usePaneLayout } from './pane-layout-context';
import './pane-layout-dialog.css';

export const paneLayoutTitle = 'Workspace layout';

export function PaneLayoutDialog({ onClose }: { onClose: () => void }) {
  const layout = usePaneLayout();
  if (!layout) return null;
  const { panes, apply } = layout;
  return (
    <Modal onClose={onClose} title={paneLayoutTitle}>
      <div className="pane-layout-dialog">
        <header>
          <h2>{paneLayoutTitle}</h2>
          <button
            className="icon-button"
            type="button"
            aria-label="Close layout settings"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </header>
        <p>
          Resize by dragging a pane edge, using the arrow keys on its divider, or entering a width
          here. Narrow windows adapt without changing saved widths.
        </p>
        <div className="pane-layout-actions" role="group" aria-label="Layout presets">
          {Object.entries(panePresets).map(([name, preset]) => (
            <button
              className="button secondary small"
              key={name}
              type="button"
              onClick={() => apply(preset)}
            >
              {name}
            </button>
          ))}
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            const next: PaneLayout = { ...panes };
            for (const id of paneIds) {
              const width = Number(data.get(`${id}-width`));
              if (
                !Number.isInteger(width) ||
                width < paneBounds[id].min ||
                width > paneBounds[id].max
              )
                return;
              next[id] = { width, open: data.has(`${id}-visible`) };
            }
            apply(next);
          }}
        >
          {paneIds.map((id) => (
            <div className="pane-layout-row" key={`${id}:${panes[id].width}:${panes[id].open}`}>
              <label>
                <input type="checkbox" name={`${id}-visible`} defaultChecked={panes[id].open} />
                {paneLabels[id]}
              </label>
              <label>
                <input
                  type="number"
                  name={`${id}-width`}
                  aria-label={`${paneLabels[id]} width`}
                  defaultValue={panes[id].width}
                  {...paneBounds[id]}
                  required
                />{' '}
                px
              </label>
            </div>
          ))}
          <footer className="pane-layout-actions">
            <button
              className="button secondary small"
              type="button"
              onClick={() => apply(defaultPaneLayout)}
            >
              Reset layout
            </button>
            <button className="button primary small" type="submit">
              Apply pane settings
            </button>
          </footer>
        </form>
        {layout.storageFailed && (
          <p role="alert">The layout changed, but could not be saved on this device.</p>
        )}
      </div>
    </Modal>
  );
}
