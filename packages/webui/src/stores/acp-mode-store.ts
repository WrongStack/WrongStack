import type { AcpNativeModeSelector } from '@wrongstack/contracts/types/acp-runtime';
import { create } from 'zustand';

/**
 * The ACP agent's own operating modes as last read for a tab (`<sessionId>/<agentId>`). The
 * engine does not broadcast mode changes, so the composer shows the last answer any `acp.mode`
 * request got in this tab — the permission chip's popover or the full ACP settings control —
 * and asks again when the chip is opened.
 */
interface AcpModeState {
  byKey: Record<string, AcpNativeModeSelector[]>;
  record: (key: string, modes: AcpNativeModeSelector[]) => void;
}

export const acpModeKey = (sessionId: string | null | undefined, agentId: string) =>
  `${sessionId ?? ''}/${agentId}`;

export const useAcpModeStore = create<AcpModeState>((set) => ({
  byKey: {},
  record: (key, modes) => set((state) => ({ byKey: { ...state.byKey, [key]: modes } })),
}));
