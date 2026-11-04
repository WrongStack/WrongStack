import { cn } from '../lib/utils';
import { OfficeMapPanel } from './OfficeMapPanel';
import { OfficeMapSettingsPanel } from './OfficeMapSettingsPanel';

/**
 * The office map with its display preferences beside it (below it on narrow windows).
 * `fill` stretches it over a container that sets its height, as the desktop page does.
 */
export function OfficeWorkspace({ fill = false }: { fill?: boolean | undefined }) {
  return (
    <div
      className={cn('flex min-h-0 min-w-0 w-full flex-col xl:flex-row', fill && 'h-full flex-1')}
    >
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        <OfficeMapPanel />
      </div>
      {/* Display preferences — relocated from the retired ActivityBar side panel */}
      <aside className="max-h-64 w-full shrink-0 overflow-y-auto border-t border-border/60 xl:max-h-none xl:w-60 xl:border-t-0 xl:border-l">
        <OfficeMapSettingsPanel />
      </aside>
    </div>
  );
}
