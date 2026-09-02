import { cn } from '@/lib/utils';
import { useAppTranslation } from '@/i18n';
import { useState } from 'react';

export function ToolInputView({ input }: { input: unknown }) {
  const { t } = useAppTranslation();
  const [openKeys, setOpenKeys] = useState<Record<string, boolean>>({});
  if (input === null || input === undefined || typeof input !== 'object' || Array.isArray(input)) {
    return (
      <pre className="whitespace-pre-wrap break-all text-xs font-mono">
        {JSON.stringify(input, null, 2)}
      </pre>
    );
  }
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length === 0) {
    return (
      <span className="text-xs text-muted-foreground italic">
        {t('activity:toolInput.noParams')}
      </span>
    );
  }
  return (
    <div className="text-xs font-mono">
      {entries.map(([k, v]) => {
        const isPrimitive =
          v === null ||
          v === undefined ||
          typeof v === 'string' ||
          typeof v === 'number' ||
          typeof v === 'boolean';
        if (isPrimitive) {
          const display =
            v === null
              ? 'null'
              : v === undefined
                ? 'undefined'
                : typeof v === 'string'
                  ? v
                  : String(v);
          const isLong = typeof v === 'string' && (display.length > 80 || display.includes('\n'));
          return (
            <div
              key={k}
              className={cn(
                'py-0.5',
                isLong ? 'flex flex-col gap-0.5' : 'flex items-baseline gap-2',
              )}
            >
              <span className="text-muted-foreground shrink-0">{k}:</span>
              <span
                className={cn(
                  'text-foreground',
                  isLong
                    ? 'whitespace-pre-wrap break-all bg-muted/40 rounded px-1.5 py-1'
                    : 'truncate',
                  typeof v === 'string' ? '' : 'text-warning',
                )}
                title={typeof v === 'string' && !isLong ? display : undefined}
              >
                {display}
              </span>
            </div>
          );
        }
        const open = !!openKeys[k];
        const summary = Array.isArray(v)
          ? `[${t('activity:toolInput.itemCount', { count: v.length })}]`
          : `{${t('activity:toolInput.keyCount', { count: Object.keys(v as object).length })}}`;
        return (
          <div key={k} className="py-0.5">
            <button
              type="button"
              onClick={() => setOpenKeys((p) => ({ ...p, [k]: !p[k] }))}
              className="flex items-baseline gap-2 hover:bg-muted/30 rounded px-1 -mx-1"
              aria-expanded={open}
            >
              <span className="text-muted-foreground/75 text-[10px]">{open ? '▾' : '▸'}</span>
              <span className="text-muted-foreground">{k}:</span>
              <span className="text-primary">{summary}</span>
            </button>
            {open && (
              <pre className="ml-3 mt-1 whitespace-pre-wrap break-all text-[11px] bg-muted/40 rounded px-2 py-1.5">
                {JSON.stringify(v, null, 2)}
              </pre>
            )}
          </div>
        );
      })}
    </div>
  );
}
