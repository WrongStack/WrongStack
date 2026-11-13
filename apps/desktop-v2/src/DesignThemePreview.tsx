import type { CSSProperties } from 'react';
import { useDesktopText } from './desktop-i18n';

export function DesignThemePreview({
  tokens,
  label,
  photo,
  compact = false,
}: {
  tokens: Record<string, string>;
  label: string;
  photo?: string | undefined;
  compact?: boolean;
}) {
  const { t } = useDesktopText();
  const photoMode = photo?.trim().split(/\s+/)[0]?.toLowerCase();
  const style: CSSProperties = {
    backgroundColor: tokens['bg'] ?? '#ffffff',
    color: tokens['fg'] ?? '#18181b',
    fontFamily: tokens['font-sans'] ?? tokens['fontSans'] ?? 'inherit',
    '--design-surface': tokens['surface'] ?? tokens['bg'] ?? '#ffffff',
    '--design-muted': tokens['muted'] ?? tokens['fg'] ?? '#666666',
    '--design-primary': tokens['primary'] ?? '#2563eb',
    '--design-accent': tokens['accent'] ?? tokens['primary'] ?? '#2563eb',
    '--design-border': tokens['border'] ?? '#dddddd',
    '--design-radius': tokens['radius-md'] ?? tokens['radius'] ?? '8px',
    '--design-display':
      tokens['font-display'] ?? tokens['fontDisplay'] ?? tokens['fontSans'] ?? 'inherit',
    '--design-weight-bold': tokens['weight-bold'] ?? '700',
    '--design-leading-tight': tokens['leading-tight'] ?? '1.1',
    '--design-tracking-tight': tokens['tracking-tight'] ?? '-0.03em',
    '--design-space': tokens['space-4'] ?? '16px',
    '--design-shadow': tokens['shadow-2'] ?? tokens['shadow'] ?? 'none',
  } as CSSProperties;
  return (
    <div
      className={`design-theme-preview ${compact ? 'design-preview-compact' : ''}`}
      style={style}
      role="img"
      aria-label={t('designStudio.themeSample', { label })}
    >
      <div className="design-preview-top">
        <span className="design-preview-brand">
          <i />
          <i />
          <i />
        </span>
        <small>{label}</small>
        <span className="design-preview-avatar" />
      </div>
      <div className="design-preview-body">
        <aside aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
        </aside>
        <div className="design-preview-canvas">
          <span className="design-preview-overline">{t('designStudio.sample.overline')}</span>
          <h3>
            {t('designStudio.sample.titleTop')}
            <br />
            {t('designStudio.sample.titleBottom')}
          </h3>
          <p>{t('designStudio.sample.body')}</p>
          <div className="design-preview-actions">
            <span>
              {t('designStudio.sample.start')} <b>↗</b>
            </span>
            <small>{t('designStudio.sample.explore')}</small>
          </div>
          <div className="design-preview-content">
            {photoMode && (
              <div
                className="design-preview-photo-slot"
                data-slot="hero"
                data-photo-mode={photoMode}
                aria-hidden="true"
              />
            )}
            <div className="design-preview-chart" aria-hidden="true">
              {[28, 45, 36, 65, 52, 84, 72, 100].map((height, i) => (
                <i key={i} style={{ height: `${height}%` }} />
              ))}
            </div>
            <div className="design-preview-lines" aria-hidden="true">
              <i />
              <i />
              <i />
            </div>
          </div>
        </div>
      </div>
      <footer>
        <span>{t('designStudio.sample.footer')}</span>
        <div>
          {['primary', 'accent', 'fg', 'surface'].map((key) => (
            <i key={key} style={{ backgroundColor: tokens[key] }} title={key} />
          ))}
        </div>
      </footer>
    </div>
  );
}
