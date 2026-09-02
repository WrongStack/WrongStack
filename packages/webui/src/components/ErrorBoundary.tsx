import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { i18n } from '@/i18n';
import { Button } from './ui/button';

interface Props {
  children: ReactNode;
  /** Optional callback when an error is caught — useful for telemetry. */
  onError?: (error: Error, info: ErrorInfo) => void;
  /**
   * `level: 'app'` (default) renders a full-viewport recovery screen — the
   * last line of defense at the root.
   * `level: 'panel'` renders a compact inline fallback so only the failing
   * panel is replaced and the rest of the UI (chat, activity bar, other
   * panels) keeps working. Pair with a `name` so the user can tell which
   * surface failed.
   */
  level?: 'app' | 'panel';
  /** Human-readable name of the wrapped surface, shown in panel fallbacks. */
  name?: string;
}

interface State {
  error: Error | null;
}

/**
 * Error boundary. At `level: 'app'` (mounted once at the root) it catches
 * rendering errors anywhere in the tree and shows a recovery screen. At
 * `level: 'panel'` it isolates failures so a crash in one view (FleetMonitor,
 * OfficeMap, Settings, …) does NOT take down the entire chat session — that
 * was the original intent of the comment below, but only the root boundary
 * existed, so any leaf crash blanked the whole app.
 *
 *   "A single crash in a leaf component must not take down the entire chat
 *    session."
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(error, info.componentStack);
    this.props.onError?.(error, info);
  }

  private handleReset = () => {
    this.setState({ error: null });
  };

  render() {
    if (!this.state.error) return this.props.children;
    const level = this.props.level ?? 'app';

    if (level === 'panel') {
      // Compact inline fallback — keeps the rest of the UI on screen.
      return (
        <div
          role="alert"
          className="flex min-h-[200px] flex-1 min-h-0 min-w-0 flex-col items-center justify-center gap-3 bg-background p-6 text-center"
        >
          <AlertTriangle className="h-8 w-8 text-destructive" />
          <div className="space-y-1">
            <p className="text-sm font-semibold">
              {this.props.name
                ? i18n.t('common:error.panelTitle', {
                    name: this.props.name,
                    defaultValue: `${this.props.name} hit an error`,
                  })
                : i18n.t('common:error.title')}
            </p>
            <pre className="max-w-md truncate text-xs font-mono text-muted-foreground">
              {this.state.error.message}
            </pre>
          </div>
          <Button size="sm" variant="outline" onClick={this.handleReset}>
            <RefreshCw className="mr-1 h-3.5 w-3.5" />
            {i18n.t('common:error.tryAgain')}
          </Button>
        </div>
      );
    }

    // Full-viewport app-level fallback — last line of defense.
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-background">
        <div className="flex max-w-md flex-col items-center gap-4 p-8 text-center">
          <AlertTriangle className="h-12 w-12 text-destructive" />
          <h1 className="text-lg font-semibold">{i18n.t('common:error.title')}</h1>
          <p className="text-sm text-muted-foreground">{i18n.t('common:error.body')}</p>
          <pre className="max-h-32 w-full overflow-auto rounded bg-muted/50 p-3 text-left text-xs font-mono text-muted-foreground">
            {this.state.error.message}
          </pre>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
              <RefreshCw className="mr-1 h-4 w-4" />
              {i18n.t('common:error.reload')}
            </Button>
            <Button size="sm" onClick={this.handleReset}>
              {i18n.t('common:error.tryAgain')}
            </Button>
          </div>
        </div>
      </div>
    );
  }
}
