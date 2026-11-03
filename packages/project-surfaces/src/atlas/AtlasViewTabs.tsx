import { Network } from 'lucide-react';
import { useAppTranslation } from '../lib/i18n';
import { cn } from '../lib/utils';
import type { AtlasView } from './atlas-host';

/** Switches the canvas between the map and the views an application adds to the atlas. */
export function AtlasViewTabs({
  views,
  active,
  onChange,
}: {
  views: readonly AtlasView[];
  active: string;
  onChange: (id: string) => void;
}): React.ReactElement {
  const { t } = useAppTranslation();
  const tabs = [
    {
      id: 'map',
      label: t('activity:codeMap.mapView'),
      hint: t('activity:codeMap.mapViewHint'),
      Icon: Network,
    },
    ...views,
  ];
  return (
    <div
      role="tablist"
      aria-label={t('activity:codeMap.atlasViews')}
      className="flex shrink-0 items-stretch overflow-x-auto border-b bg-card/80"
    >
      {tabs.map(({ id, label, hint, Icon }) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={active === id}
          title={hint}
          onClick={() => onChange(id)}
          className={cn(
            'flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-[10px] font-semibold uppercase tracking-wider',
            active === id
              ? 'border-primary text-primary'
              : 'border-transparent text-muted-foreground hover:bg-muted hover:text-foreground',
          )}
        >
          <Icon className="h-3.5 w-3.5" />
          {label}
        </button>
      ))}
    </div>
  );
}
