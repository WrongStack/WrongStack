export const TERMINAL_HEIGHT_STORAGE_KEY = 'wrongstack.terminalDockHeight';
export const MIN_TERMINAL_HEIGHT = 140;
export const MAX_TERMINAL_HEIGHT = 640;
const MIN_MAIN_AREA_WHEN_TERMINAL_OPEN = 260;

export function clampTerminalHeight(height: number): number {
  const viewportMax =
    typeof window === 'undefined'
      ? MAX_TERMINAL_HEIGHT
      : Math.max(
          MIN_TERMINAL_HEIGHT,
          Math.min(
            MAX_TERMINAL_HEIGHT,
            Math.floor(window.innerHeight * 0.55),
            window.innerHeight - MIN_MAIN_AREA_WHEN_TERMINAL_OPEN,
          ),
        );
  return Math.min(Math.max(Math.round(height), MIN_TERMINAL_HEIGHT), viewportMax);
}
