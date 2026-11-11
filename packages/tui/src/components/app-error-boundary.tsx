import { scrubErrorText } from '@wrongstack/core/security';
import { Component, type ReactElement, type ReactNode } from 'react';
import { Box, Text, useInput } from '../ink.js';
import { theme } from '../theme.js';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  /** Bumped on retry so the subtree remounts with fresh state. */
  attempt: number;
}

/**
 * Last-resort boundary around the whole App.
 *
 * `EntryErrorBoundary` already confines a malformed transcript row to one
 * line. Everything else (the composer, the status bar, a panel, a controller
 * hook) had no boundary: a single render throw there unmounted the entire
 * Ink tree and ended the session with "TUI render failed", even though the
 * agent, its conversation and its session log were all still intact.
 *
 * This keeps the process and the session alive instead. The failed tree is
 * replaced by a short notice; Enter remounts the App, which rebuilds its
 * screen from the live conversation. Ctrl+C keeps working throughout: the raw
 * stdin watcher in run-tui handles it below React.
 */
export class AppErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, attempt: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  override componentDidCatch(error: Error): void {
    // Same structured line the per-entry boundary writes, so a paused
    // interface is diagnosable from the log rather than only from the notice.
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'app_render_error',
        message: scrubErrorText(error.stack ?? error.message ?? String(error)),
        timestamp: new Date().toISOString(),
      }),
    );
  }

  private readonly retry = (): void => {
    this.setState((state) => ({ error: null, attempt: state.attempt + 1 }));
  };

  override render(): ReactNode {
    const { error, attempt } = this.state;
    if (error) return <AppErrorNotice error={error} onRetry={this.retry} />;
    return <AppSubtree key={attempt}>{this.props.children}</AppSubtree>;
  }
}

/** Keyed wrapper: a new key on retry discards the failed subtree's state. */
function AppSubtree({ children }: { children: ReactNode }): ReactNode {
  return children;
}

function AppErrorNotice({ error, onRetry }: { error: Error; onRetry: () => void }): ReactElement {
  useInput((_input, key) => {
    if (key.return) onRetry();
  });
  const message = scrubErrorText(error.message || String(error));
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color={theme.error}>
        ⚠ The interface hit an error and was paused.
      </Text>
      <Text color={theme.textMuted} wrap="wrap">
        {message}
      </Text>
      <Text> </Text>
      <Text>Your session and conversation are intact.</Text>
      <Text>
        <Text bold>Enter</Text> reload the interface · <Text bold>Ctrl+C</Text> exit
      </Text>
    </Box>
  );
}
