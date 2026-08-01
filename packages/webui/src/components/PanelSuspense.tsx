/**
 * Suspense fallback for lazy-loaded views — a quiet centered spinner so the
 * first open of the editor / terminal / office map doesn't look frozen.
 */
export function PanelSuspense({ label }: { label?: string }): React.ReactElement {
  return (
    <div className="flex flex-1 min-h-0 min-w-0 items-center justify-center bg-background text-muted-foreground">
      <div className="flex flex-col items-center gap-3">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-primary" />
        {label ? <span className="text-xs">{label}</span> : null}
      </div>
    </div>
  );
}
