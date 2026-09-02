import type { BaseWindow, Display, Rectangle } from 'electron';
import type { DesktopWindowState } from '../shared/types.js';
import { MIN_WINDOW_HEIGHT, MIN_WINDOW_WIDTH } from './state/constants.js';

export interface DesktopWindowStateControllerContext {
  getWindow(): BaseWindow | null;
  getDisplays(): Display[];
  save(state: DesktopWindowState): Promise<void>;
}

/** Owns debounced window persistence and display-aware restoration validation. */
export class DesktopWindowStateController {
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly ctx: DesktopWindowStateControllerContext) {}

  scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.save();
    }, 350);
  }

  async save(): Promise<void> {
    const window = this.ctx.getWindow();
    if (!window || window.isDestroyed?.()) return;
    const bounds = window.getNormalBounds();
    await this.ctx.save({ ...bounds, maximized: window.isMaximized() });
  }

  validated(state: DesktopWindowState | null): DesktopWindowState | null {
    if (
      !state ||
      !Number.isFinite(state.width) ||
      !Number.isFinite(state.height) ||
      state.width < MIN_WINDOW_WIDTH ||
      state.height < MIN_WINDOW_HEIGHT
    )
      return null;
    if (state.x === undefined || state.y === undefined) {
      return { width: state.width, height: state.height, maximized: state.maximized };
    }
    const candidate = { x: state.x, y: state.y, width: state.width, height: state.height };
    return this.ctx.getDisplays().some(({ workArea }) => intersects(candidate, workArea))
      ? {
          x: state.x,
          y: state.y,
          width: state.width,
          height: state.height,
          maximized: state.maximized,
        }
      : null;
  }
}

function intersects(left: Rectangle, right: Rectangle): boolean {
  return (
    left.x < right.x + right.width &&
    left.x + left.width > right.x &&
    left.y < right.y + right.height &&
    left.y + left.height > right.y
  );
}
