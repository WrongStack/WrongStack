import { CheckCircle2, Circle, FileCode2, Loader2, Palette } from 'lucide-react';
import { useMemo } from 'react';
import { useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { showPanel } from '@/lib/view-navigation';

interface Props {
  status: 'running' | 'error' | 'ok';
  input: unknown;
  result?: string | undefined;
  progressLines?: readonly string[] | undefined;
}

const STAGES = [
  { step: 1, key: 'stageCrawl', fallback: '5-Breakpoint Crawl' },
  { step: 2, key: 'stageSubpages', fallback: 'Subpage Discovery' },
  { step: 3, key: 'stageSynthesis', fallback: 'DNA Synthesis' },
  { step: 4, key: 'stageSpec', fallback: '10-Section DESIGN.md' },
] as const;

function detectActiveStep(progressLines: readonly string[] | undefined): number {
  if (!progressLines || progressLines.length === 0) return 1;
  let highest = 1;
  for (const line of progressLines) {
    const m = /\[([1-4])\/4\]/.exec(line);
    if (m?.[1]) {
      const n = Number.parseInt(m[1], 10);
      if (n > highest) highest = n;
    }
  }
  return highest;
}

function parseExtractArtifacts(result: string | undefined): {
  designMdPath?: string;
  referenceSlug?: string;
  pagesAnalyzed?: number;
} {
  if (!result) return {};
  // Result may be JSON `{ action, path, reference, output }` or plain text `output`.
  let text = result;
  let referenceSlug: string | undefined;
  if (result.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(result) as {
        output?: unknown;
        reference?: unknown;
        path?: unknown;
      };
      if (typeof parsed.output === 'string') text = parsed.output;
      if (typeof parsed.reference === 'string') referenceSlug = parsed.reference;
    } catch {
      // treat as raw text
    }
  }
  const mdMatch = /Full 10-section DESIGN\.md specification:\s*([^\s]+\/DESIGN\.md)/i.exec(text);
  const savedMatch = /Saved:\s*([^\s{]+)\/\{[^}]*DESIGN\.md[^}]*\}/i.exec(text);
  const refMatch = /Reference name for compare:\s*"([^"]+)"/i.exec(text);
  const pagesMatch = /\((\d+)\s+page\(s\)\s+analyzed/i.exec(text);
  const designMdPath =
    mdMatch?.[1]?.replace(/\.$/, '') ??
    (savedMatch?.[1] ? `${savedMatch[1]}/DESIGN.md` : undefined);
  return {
    designMdPath,
    referenceSlug: referenceSlug ?? refMatch?.[1],
    pagesAnalyzed: pagesMatch?.[1] ? Number.parseInt(pagesMatch[1], 10) : undefined,
  };
}

export function DesignReferenceCard({ status, input, result, progressLines }: Props) {
  const { t } = useAppTranslation();
  const action =
    input && typeof input === 'object' && typeof (input as { action?: unknown }).action === 'string'
      ? ((input as { action: string }).action as string)
      : 'extract';

  const activeStep = useMemo(() => detectActiveStep(progressLines), [progressLines]);
  const artifacts = useMemo(
    () => (status === 'ok' && action === 'extract' ? parseExtractArtifacts(result) : {}),
    [action, result, status],
  );

  if (action !== 'extract') return null;

  const openDesignMd = (filePath: string) => {
    window.dispatchEvent(new CustomEvent('wrongstack:open-file', { detail: { filePath } }));
  };

  return (
    <div
      data-testid="design-reference-pipeline"
      className="border-t border-border/40 bg-primary/[0.025] px-3 py-2 font-sans text-xs"
    >
      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
        {STAGES.map(({ step, key, fallback }) => {
          const done = status === 'ok' || (status === 'running' && step < activeStep);
          const current = status === 'running' && step === activeStep;
          return (
            <div
              key={step}
              className={cn(
                'flex items-center gap-1.5 rounded border px-2 py-1 text-[11px] transition-colors',
                done
                  ? 'border-success/35 bg-success/[0.07] text-foreground'
                  : current
                    ? 'border-primary/45 bg-primary/10 font-medium text-foreground'
                    : 'border-border/45 bg-background/50 text-muted-foreground',
              )}
            >
              {done ? (
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" aria-hidden />
              ) : current ? (
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" aria-hidden />
              ) : (
                <Circle className="h-3 w-3 shrink-0 opacity-45" aria-hidden />
              )}
              <span className="truncate">
                {step}. {t(`setup:welcome.design.${key}`, fallback)}
              </span>
            </div>
          );
        })}
      </div>

      {status === 'ok' && artifacts.designMdPath && (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded border border-border/50 bg-background/70 px-2.5 py-1.5">
          <div className="flex min-w-0 items-center gap-2 font-mono text-[11px]">
            <FileCode2 className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
            <span className="truncate font-semibold text-foreground" title={artifacts.designMdPath}>
              {artifacts.designMdPath}
            </span>
            {artifacts.pagesAnalyzed !== undefined && (
              <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {artifacts.pagesAnalyzed}p · 5vp
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => openDesignMd(artifacts.designMdPath!)}
              className="inline-flex items-center gap-1 rounded border border-primary/40 bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary hover:bg-primary/20 transition-colors"
            >
              <FileCode2 className="h-3 w-3" aria-hidden />
              {t('setup:welcome.design.openDesignMd', 'Open DESIGN.md')}
            </button>
            <button
              type="button"
              onClick={() => showPanel('design')}
              className="inline-flex items-center gap-1 rounded border border-border/60 bg-background px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            >
              <Palette className="h-3 w-3" aria-hidden />
              {t('setup:welcome.design.openStudio', 'Design Studio')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
