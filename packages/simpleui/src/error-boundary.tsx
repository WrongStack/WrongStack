import { TriangleAlert } from 'lucide-react';
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
  /** Section name for the structured log line. */
  section?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
  /** Bumped on Retry so the children truly re-mount instead of re-rendering
   *  with stale state that may immediately re-crash. */
  attempt: number;
}

/**
 * Catches uncaught render errors so a crash in one section
 * (message list, tool accordion, etc.) doesn't take down
 * the entire chat surface. The composer stays functional.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null, attempt: 0 };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error, attempt: 0 };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'simpleui.error_boundary',
        section: this.props.section,
        message: error.message,
        stack: error.stack,
        componentStack: info.componentStack,
        timestamp: new Date().toISOString(),
      }),
    );
  }

  static displayName = 'ErrorBoundary';

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      this.props.fallback ?? (
        <div className="error-boundary-fallback" role="alert">
          <TriangleAlert size={14} className="error-boundary-icon" aria-hidden="true" />
          <span className="error-boundary-text">Something went wrong in this section</span>
          <span className="error-boundary-detail">{this.state.error.message}</span>
          <div className="error-boundary-actions">
            <button
              type="button"
              className="error-boundary-retry"
              onClick={() =>
                this.setState((state) => ({ error: null, attempt: state.attempt + 1 }))
              }
            >
              Retry
            </button>
            <button
              type="button"
              className="error-boundary-copy"
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(
                    `${String(this.state.error?.message ?? '')}\n${String(this.state.error?.stack ?? '')}`,
                  )
                  .catch(() => undefined);
              }}
            >
              Copy details
            </button>
          </div>
        </div>
      )
    );
  }
}
