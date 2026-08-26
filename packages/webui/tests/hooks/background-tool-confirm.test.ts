import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/ws-client', () => ({
  getWSClient: () => ({ sendConfirm: vi.fn(), consumeRequestedSwitch: () => false }),
}));

import { handleToolConfirmNeeded } from '@/hooks/ws-handlers/chat-handlers';
import {
  chatLane,
  ensureLane,
  readLane,
  resolvePendingConfirm,
  setActiveLane,
  useChatLanes,
} from '@/stores/chat-lanes';
import { useLocalPrefs } from '@/stores/local-prefs';
import { useUIStore } from '@/stores/ui-store';
import type { WSServerMessage } from '@/types';

/**
 * A tool waiting for approval in a BACKGROUND tab.
 *
 * Two separate defects lived here. The prompt was discarded rather than
 * parked, so a background run sat blocked behind an attention dot with no way
 * to answer it — the comment in the handler promised it would "open when the
 * user goes there" and nothing implemented that. And the YOLO check read the
 * flat pref, which describes the tab in FRONT: a background tab's tool was
 * auto-approved because a different tab was in YOLO.
 */

function confirmMessage(sessionId: string, id = 'confirm-1'): WSServerMessage {
  return {
    type: 'tool.confirm_needed',
    payload: {
      sessionId,
      id,
      toolName: 'Bash',
      input: { command: 'rm -rf build' },
      suggestedPattern: 'Bash(rm:*)',
    },
  } as WSServerMessage;
}

beforeEach(() => {
  useChatLanes.setState({ lanes: {}, activeSessionId: '__unbound__' });
  useLocalPrefs.setState({
    yolo: false,
    bySession: {},
    sessionDefaults: {},
    activeSessionId: null,
  } as never);
  useUIStore.getState().hideConfirm();
  ensureLane('tab-1');
  ensureLane('tab-2');
  setActiveLane('tab-1');
});

describe('an approval prompt raised by a background tab', () => {
  it('does not open a modal over the tab in front', () => {
    handleToolConfirmNeeded(confirmMessage('tab-2'));
    expect(useUIStore.getState().showConfirmDialog).toBe(false);
    expect(useUIStore.getState().confirmInfo).toBeNull();
  });

  it('is parked on the tab that raised it, not lost', () => {
    handleToolConfirmNeeded(confirmMessage('tab-2'));
    expect(readLane('tab-2').pendingConfirm?.id).toBe('confirm-1');
    expect(readLane('tab-2').pendingConfirm?.toolName).toBe('Bash');
    // …and nothing lands on the foreground lane.
    expect(readLane('tab-1').pendingConfirm).toBeNull();
  });

  it('opens for the foreground tab immediately', () => {
    handleToolConfirmNeeded(confirmMessage('tab-1'));
    expect(useUIStore.getState().showConfirmDialog).toBe(true);
    expect(useUIStore.getState().confirmInfo?.id).toBe('confirm-1');
  });

  it('is retired once answered, so a later switch cannot re-open it', () => {
    handleToolConfirmNeeded(confirmMessage('tab-2'));
    resolvePendingConfirm('confirm-1');
    expect(readLane('tab-2').pendingConfirm).toBeNull();
  });

  it('leaves an unrelated tab’s parked prompt alone when another is answered', () => {
    handleToolConfirmNeeded(confirmMessage('tab-2', 'confirm-A'));
    setActiveLane('tab-2');
    handleToolConfirmNeeded(confirmMessage('tab-1', 'confirm-B'));
    resolvePendingConfirm('confirm-A');
    expect(readLane('tab-1').pendingConfirm?.id).toBe('confirm-B');
  });

  it('is wiped when its conversation is cleared', () => {
    handleToolConfirmNeeded(confirmMessage('tab-2'));
    chatLane('tab-2').clearMessages();
    expect(readLane('tab-2').pendingConfirm).toBeNull();
  });
});

describe('YOLO is read from the session that raised the prompt', () => {
  it('does not auto-approve a background tab because the foreground is in YOLO', () => {
    useLocalPrefs.getState().bindSession('tab-1');
    useLocalPrefs.getState().set({ yolo: true });

    // tab-2 never opted in.
    useLocalPrefs.setState({
      bySession: { ...useLocalPrefs.getState().bySession, 'tab-2': { yolo: false } },
    } as never);

    handleToolConfirmNeeded(confirmMessage('tab-2'));

    // Still waiting for a human, parked on its own tab.
    expect(readLane('tab-2').pendingConfirm?.id).toBe('confirm-1');
  });

  it('auto-approves when the raising session itself is in YOLO', () => {
    useLocalPrefs.getState().bindSession('tab-1');
    useLocalPrefs.setState({
      bySession: { 'tab-2': { yolo: true } },
    } as never);

    handleToolConfirmNeeded(confirmMessage('tab-2'));

    expect(readLane('tab-2').pendingConfirm).toBeNull();
    expect(useUIStore.getState().showConfirmDialog).toBe(false);
  });
});
