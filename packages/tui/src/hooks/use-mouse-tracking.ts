import { useEffect, useRef, useState } from 'react';
import { MOUSE_DRAG_ON, MOUSE_OFF, shouldEnableMouseTracking } from '../mouse.js';
import type { MouseTrackingPolicy } from '../mouse.js';

type MouseWritable = { write(data: string): unknown } | undefined;

export function useMouseTracking(input: {
  initialMouseMode: boolean;
  initialNativeMouse?: boolean | undefined;
  overlayOpen: boolean;
  protocol?: MouseTrackingPolicy['protocol'];
  stdout: MouseWritable;
}): {
  mouseMode: boolean;
  setMouseMode: (value: boolean) => void;
  nativeMouse: boolean;
  setNativeMouse: (value: boolean) => void;
} {
  const { initialMouseMode, initialNativeMouse, overlayOpen, protocol, stdout } = input;
  const [mouseMode, setMouseMode] = useState(initialMouseMode);
  const [nativeMouse, setNativeMouse] = useState(initialNativeMouse ?? false);
  const mouseTrackingOn = shouldEnableMouseTracking({
    fullMode: mouseMode,
    overlayOpen,
    managedHistory: true,
    native: nativeMouse,
    protocol,
  });
  // Button-drag tracking (?1002h: click + wheel + motion-while-held) is
  // enabled whenever tracking is on — managed default and full mode alike —
  // because drag-to-select-and-copy in the history needs held-drag motion
  // reports. This hook never enables free hover (?1003h). Native terminal
  // selection is unavailable under ANY tracking mode, so escalating managed
  // mode from click-only to drag loses nothing.
  const mouseTrackingSequence = mouseTrackingOn ? MOUSE_DRAG_ON : MOUSE_OFF;
  const mouseWrittenRef = useRef<string | null>(null);

  useEffect(() => {
    if (mouseWrittenRef.current === mouseTrackingSequence) return;
    mouseWrittenRef.current = mouseTrackingSequence;
    try {
      stdout?.write(mouseTrackingSequence);
    } catch {
      // stdout closed during shutdown.
    }
  }, [mouseTrackingSequence, stdout]);

  useEffect(
    () => () => {
      const wasTracking = mouseWrittenRef.current !== null && mouseWrittenRef.current !== MOUSE_OFF;
      mouseWrittenRef.current = null;
      if (!wasTracking) return;
      try {
        stdout?.write(MOUSE_OFF);
      } catch {
        // process is tearing down.
      }
    },
    [stdout],
  );

  return { mouseMode, setMouseMode, nativeMouse, setNativeMouse };
}
