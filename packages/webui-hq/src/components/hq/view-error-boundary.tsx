/**
 * Per-view failure boundary.
 *
 * One broken surface must not take down the command center: the operator
 * still needs the nav, the alerts badge and the other eleven views. Switching
 * views clears the error, and a Retry button re-mounts in place.
 */
import { RotateCcw, ShieldAlert } from 'lucide-react';
import { Component, type ReactNode } from 'react';
import type { HqViewId } from '../../data/store/index.js';
import { Button } from '../ui/button.js';

interface Props {
  view: HqViewId;
  children: ReactNode;
}

interface State {
  error: string | null;
}

export class ViewErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  componentDidUpdate(previous: Props): void {
    if (previous.view !== this.props.view && this.state.error !== null) {
      this.setState({ error: null });
    }
  }

  render(): ReactNode {
    if (this.state.error === null) return this.props.children;
    return (
      <div
        role="alert"
        data-testid="view-error"
        className="m-4 flex items-start gap-3 border border-destructive/40 bg-destructive/5 p-4"
      >
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
        <div className="flex-1 space-y-1">
          <p className="text-sm font-semibold">This HQ surface stopped safely.</p>
          <p className="font-mono text-[11px] text-muted-foreground">{this.state.error}</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => this.setState({ error: null })}>
          <RotateCcw className="size-3" />
          Retry view
        </Button>
      </div>
    );
  }
}
