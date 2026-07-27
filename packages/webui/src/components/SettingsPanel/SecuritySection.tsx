import { Eye } from 'lucide-react';
import { useAppTranslation } from '@/i18n';
import { BrainSection } from './BrainSection';
import { ShadowSection } from './ShadowSection';
import { ToolsSection } from './ToolsSection';

export function SecuritySection() {
  const { t } = useAppTranslation();

  return (
    <div className="space-y-6">
      {/* Brain — Decision Control */}
      <div className="rounded-xl border border-border/70 bg-card/80 p-5 shadow-sm">
        <div className="flex items-center gap-3 mb-4 pb-3 border-b border-border/50">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary">
            <Eye className="h-5 w-5" />
          </span>
          <div>
            <h3 className="text-sm font-semibold">{t('settings:security.brainHeading')}</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              {t('settings:security.brainHint')}
            </p>
          </div>
        </div>
        <BrainSection />
      </div>

      {/* Shadow Agent */}
      <div className="rounded-xl border border-border/70 bg-card/80 p-5 shadow-sm">
        <div className="flex items-center gap-3 mb-4 pb-3 border-b border-border/50">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary">
            <Eye className="h-5 w-5" />
          </span>
          <div>
            <h3 className="text-sm font-semibold">{t('settings:security.shadowHeading')}</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              {t('settings:security.shadowHint')}
            </p>
          </div>
        </div>
        <ShadowSection />
      </div>

      {/* Tool Access Control */}
      <div className="rounded-xl border border-border/70 bg-card/80 p-5 shadow-sm">
        <div className="flex items-center gap-3 mb-4 pb-3 border-b border-border/50">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary">
            <Eye className="h-5 w-5" />
          </span>
          <div>
            <h3 className="text-sm font-semibold">{t('settings:security.toolsHeading')}</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              {t('settings:security.toolsHint')}
            </p>
          </div>
        </div>
        <ToolsSection />
      </div>
    </div>
  );
}
