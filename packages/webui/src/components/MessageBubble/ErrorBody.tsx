import { expectDefined } from '@wrongstack/core/utils/expect-defined';
import { useState } from 'react';
import { useAppTranslation } from '@/i18n';
function detectStackBoundary(text: string): number {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const ln = expectDefined(lines[i]);
    if (/^\s*at\s+\S+.*\(.*:\d+:\d+\)\s*$/.test(ln)) return i;
    if (/^\s*at\s+\S+\.\S+\(\S+\.java:\d+\)\s*$/.test(ln)) return i;
    if (/^\s+File "[^"]+", line \d+/.test(ln)) return i;
  }
  return -1;
}

export function ErrorBodyWithStack({ text }: { text: string }) {
  const { t } = useAppTranslation();
  const idx = detectStackBoundary(text);
  const [open, setOpen] = useState(false);
  if (idx === -1) {
    return (
      <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">
        {text}
      </pre>
    );
  }
  const lines = text.split('\n');
  const head = lines.slice(0, idx).join('\n').trim();
  const stack = lines.slice(idx).join('\n');
  const frameCount = stack.split('\n').filter((l) => l.trim().length > 0).length;
  return (
    <div className="space-y-2">
      {head && (
        <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">
          {head}
        </pre>
      )}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 text-xs text-destructive hover:text-destructive/80 font-medium"
      >
        {open ? '▾' : '▸'}{' '}
        {open
          ? t('activity:errorBody.hideStack', { count: frameCount })
          : t('activity:errorBody.showStack', { count: frameCount })}
      </button>
      {open && (
        <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-snug bg-destructive/5 border border-destructive/20 rounded p-2 max-h-80 overflow-auto">
          {stack}
        </pre>
      )}
    </div>
  );
}
