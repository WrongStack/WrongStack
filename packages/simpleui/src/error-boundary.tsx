import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Catches uncaught render errors so a crash in one section
 * (message list, tool accordion, etc.) doesn't take down
 * the entire chat surface. The composer stays functional.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'simpleui.error_boundary',
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
        <div className="error-boundary-fallback">
          <span className="error-boundary-icon">⚠</span>
          <span className="error-boundary-text">Something went wrong in this section</span>
          <button
            type="button"
            className="error-boundary-retry"
            onClick={() => this.setState({ error: null })}
          >
            Retry
          </button>
        </div>
      )
    );
  }
}
