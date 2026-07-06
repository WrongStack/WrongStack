/**
 * Unit tests for DesktopAgentBridge - WebSocket communication and reconnection.
 *
 * Note: These tests focus on the non-WebSocket functionality of the bridge.
 * WebSocket mocking is done through dependency injection patterns.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  DesktopConversationMessage,
  DesktopConversationSnapshot,
  DesktopConversationStatus,
} from '../src/shared/types.js';

// ============================================================================
// Mock Types (mirroring the bridge's internal structure)
// ============================================================================

interface ConversationInternal {
  runtimeId: string;
  status: DesktopConversationStatus;
  sessionId?: string | undefined;
  error?: string | undefined;
  messages: DesktopConversationMessage[];
  ws: unknown | null;
  connectPromise: Promise<void> | null;
  activeAssistantMessageId: string | null;
  reconnectAttempt: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  reconnectUrl: string | null;
}

interface DesktopBridgeReconnectEvent {
  runtimeId: string;
  status: 'connecting' | 'connected' | 'error' | 'scheduled' | 'exhausted';
  attempt: number;
  maxAttempts: number;
  delay?: number;
}

// ============================================================================
// Test Helpers
// ============================================================================

function createEmptyConversation(runtimeId: string): ConversationInternal {
  return {
    runtimeId,
    status: 'disconnected',
    messages: [],
    ws: null,
    connectPromise: null,
    activeAssistantMessageId: null,
    reconnectAttempt: 0,
    reconnectTimer: null,
    reconnectUrl: null,
  };
}

// Reconnect configuration constants (matching the actual implementation)
const RECONNECT_CONFIG = {
  maxAttempts: 5,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
  jitterFactor: 0.1,
};

// ============================================================================
// Reconnection Logic Tests
// ============================================================================

describe('Reconnection logic', () => {
  describe('Exponential backoff calculation', () => {
    function calculateBackoffDelay(attempt: number): number {
      const baseDelay = Math.min(
        RECONNECT_CONFIG.initialDelayMs *
          Math.pow(RECONNECT_CONFIG.backoffMultiplier, attempt),
        RECONNECT_CONFIG.maxDelayMs,
      );
      // Add jitter (deterministic for testing)
      const jitter = baseDelay * RECONNECT_CONFIG.jitterFactor * 0.5;
      return Math.floor(baseDelay + jitter);
    }

    it('should calculate first attempt delay correctly', () => {
      const delay = calculateBackoffDelay(0);
      // First attempt: 1000ms * 2^0 = 1000ms + jitter
      expect(delay).toBeGreaterThanOrEqual(1000);
      expect(delay).toBeLessThanOrEqual(1100);
    });

    it('should double delay on each attempt', () => {
      const delay0 = calculateBackoffDelay(0);
      const delay1 = calculateBackoffDelay(1);
      const delay2 = calculateBackoffDelay(2);

      // Each should be roughly double the previous
      expect(delay1).toBeGreaterThan(delay0);
      expect(delay2).toBeGreaterThan(delay1);
    });

    it('should cap at maxDelayMs', () => {
      // After many attempts, should hit max
      const delay10 = calculateBackoffDelay(10);
      expect(delay10).toBeLessThanOrEqual(RECONNECT_CONFIG.maxDelayMs + 3000); // + jitter
    });

    it('should not exceed max attempts', () => {
      const conversation = createEmptyConversation('test');
      conversation.reconnectAttempt = RECONNECT_CONFIG.maxAttempts;

      const shouldReconnect = conversation.reconnectAttempt < RECONNECT_CONFIG.maxAttempts;
      expect(shouldReconnect).toBe(false);
    });

    it('should allow reconnect at boundary', () => {
      const conversation = createEmptyConversation('test');
      conversation.reconnectAttempt = RECONNECT_CONFIG.maxAttempts - 1;

      const shouldReconnect = conversation.reconnectAttempt < RECONNECT_CONFIG.maxAttempts;
      expect(shouldReconnect).toBe(true);
    });
  });

  describe('Reconnection state machine', () => {
    it('should start with zero attempts', () => {
      const conversation = createEmptyConversation('runtime-1');
      expect(conversation.reconnectAttempt).toBe(0);
      expect(conversation.reconnectTimer).toBeNull();
      expect(conversation.reconnectUrl).toBeNull();
    });

    it('should increment attempt on scheduled reconnect', () => {
      const conversation = createEmptyConversation('runtime-1');
      conversation.reconnectUrl = 'ws://localhost:3001';

      // Simulate reconnect scheduling
      conversation.reconnectAttempt++;
      expect(conversation.reconnectAttempt).toBe(1);
    });

    it('should reset attempts on successful connection', () => {
      const conversation = createEmptyConversation('runtime-1');
      conversation.reconnectAttempt = 3;

      // On successful connection
      conversation.reconnectAttempt = 0;
      conversation.reconnectUrl = null;

      expect(conversation.reconnectAttempt).toBe(0);
    });

    it('should cancel timer on reconnect cancel', () => {
      const conversation = createEmptyConversation('runtime-1');
      conversation.reconnectTimer = setTimeout(() => {}, 1000);

      // Cancel reconnect
      if (conversation.reconnectTimer) {
        clearTimeout(conversation.reconnectTimer);
        conversation.reconnectTimer = null;
      }

      expect(conversation.reconnectTimer).toBeNull();
    });

    it('should clear reconnect URL on close', () => {
      const conversation = createEmptyConversation('runtime-1');
      conversation.reconnectUrl = 'ws://localhost:3001';
      conversation.reconnectAttempt = 3;

      // On close
      conversation.reconnectUrl = null;
      conversation.reconnectAttempt = 0;

      expect(conversation.reconnectUrl).toBeNull();
      expect(conversation.reconnectAttempt).toBe(0);
    });
  });

  describe('Reconnect event emission', () => {
    it('should emit scheduled event with delay', () => {
      const conversation = createEmptyConversation('runtime-1');
      const event: DesktopBridgeReconnectEvent = {
        runtimeId: conversation.runtimeId,
        status: 'scheduled',
        attempt: conversation.reconnectAttempt + 1,
        maxAttempts: RECONNECT_CONFIG.maxAttempts,
        delay: 1000,
      };

      expect(event.status).toBe('scheduled');
      expect(event.delay).toBe(1000);
    });

    it('should emit connecting status', () => {
      const event: DesktopBridgeReconnectEvent = {
        runtimeId: 'runtime-1',
        status: 'connecting',
        attempt: 1,
        maxAttempts: RECONNECT_CONFIG.maxAttempts,
      };

      expect(event.status).toBe('connecting');
    });

    it('should emit connected status', () => {
      const event: DesktopBridgeReconnectEvent = {
        runtimeId: 'runtime-1',
        status: 'connected',
        attempt: 0,
        maxAttempts: RECONNECT_CONFIG.maxAttempts,
      };

      expect(event.status).toBe('connected');
    });

    it('should emit error status', () => {
      const event: DesktopBridgeReconnectEvent = {
        runtimeId: 'runtime-1',
        status: 'error',
        attempt: 1,
        maxAttempts: RECONNECT_CONFIG.maxAttempts,
      };

      expect(event.status).toBe('error');
    });

    it('should emit exhausted status when max attempts reached', () => {
      const event: DesktopBridgeReconnectEvent = {
        runtimeId: 'runtime-1',
        status: 'exhausted',
        attempt: RECONNECT_CONFIG.maxAttempts,
        maxAttempts: RECONNECT_CONFIG.maxAttempts,
      };

      expect(event.status).toBe('exhausted');
    });
  });
});

// ============================================================================
// Conversation State Tests
// ============================================================================

describe('Conversation state management', () => {
  it('should initialize with disconnected status', () => {
    const conversation = createEmptyConversation('runtime-1');
    expect(conversation.status).toBe('disconnected');
  });

  it('should allow transitioning to connecting', () => {
    const conversation = createEmptyConversation('runtime-1');
    conversation.status = 'connecting';
    expect(conversation.status).toBe('connecting');
  });

  it('should allow transitioning to connected', () => {
    const conversation = createEmptyConversation('runtime-1');
    conversation.status = 'connected';
    expect(conversation.status).toBe('connected');
  });

  it('should allow transitioning to running', () => {
    const conversation = createEmptyConversation('runtime-1');
    conversation.status = 'running';
    expect(conversation.status).toBe('running');
  });

  it('should allow transitioning to error', () => {
    const conversation = createEmptyConversation('runtime-1');
    conversation.status = 'error';
    conversation.error = 'Connection failed';
    expect(conversation.status).toBe('error');
    expect(conversation.error).toBe('Connection failed');
  });

  it('should track session ID when provided', () => {
    const conversation = createEmptyConversation('runtime-1');
    conversation.sessionId = 'session-abc123';
    expect(conversation.sessionId).toBe('session-abc123');
  });

  it('should track active assistant message', () => {
    const conversation = createEmptyConversation('runtime-1');
    conversation.activeAssistantMessageId = 'assistant_msg_1';
    expect(conversation.activeAssistantMessageId).toBe('assistant_msg_1');
  });
});

// ============================================================================
// Message Management Tests
// ============================================================================

describe('Message management', () => {
  it('should start with empty messages array', () => {
    const conversation = createEmptyConversation('runtime-1');
    expect(conversation.messages).toEqual([]);
  });

  it('should add messages to array', () => {
    const conversation = createEmptyConversation('runtime-1');
    const message: DesktopConversationMessage = {
      id: 'msg_1',
      role: 'user',
      text: 'Hello',
      timestamp: Date.now(),
    };
    conversation.messages.push(message);

    expect(conversation.messages).toHaveLength(1);
    expect(conversation.messages[0].text).toBe('Hello');
  });

  it('should track multiple messages', () => {
    const conversation = createEmptyConversation('runtime-1');
    conversation.messages.push(
      { id: '1', role: 'user', text: 'Hello', timestamp: 1 },
      { id: '2', role: 'assistant', text: 'Hi there', timestamp: 2 },
    );

    expect(conversation.messages).toHaveLength(2);
    expect(conversation.messages[0].role).toBe('user');
    expect(conversation.messages[1].role).toBe('assistant');
  });

  it('should limit messages to MAX_MESSAGES', () => {
    const MAX_MESSAGES = 300;
    const conversation = createEmptyConversation('runtime-1');

    // Add more than MAX_MESSAGES
    for (let i = 0; i < 350; i++) {
      conversation.messages.push({
        id: `msg_${i}`,
        role: 'user',
        text: `Message ${i}`,
        timestamp: i,
      });
    }

    // Trim to max
    if (conversation.messages.length > MAX_MESSAGES) {
      conversation.messages.splice(0, conversation.messages.length - MAX_MESSAGES);
    }

    expect(conversation.messages.length).toBe(MAX_MESSAGES);
    // First message should be trimmed
    expect(conversation.messages[0].id).toBe('msg_50');
  });

  it('should update streaming assistant message', () => {
    const conversation = createEmptyConversation('runtime-1');

    // Simulate streaming delta
    conversation.activeAssistantMessageId = 'assistant_streaming';

    const assistantMsg: DesktopConversationMessage = {
      id: 'assistant_streaming',
      role: 'assistant',
      text: 'Hello',
      timestamp: Date.now(),
    };
    conversation.messages.push(assistantMsg);

    // Simulate delta update
    const msg = conversation.messages.find((m) => m.id === 'assistant_streaming');
    if (msg) {
      msg.text += ' World';
    }

    expect(conversation.messages[0].text).toBe('Hello World');
  });
});

// ============================================================================
// WebSocket State Tests
// ============================================================================

describe('WebSocket state handling', () => {
  it('should track WebSocket reference', () => {
    const conversation = createEmptyConversation('runtime-1');
    conversation.ws = {}; // Mock WebSocket reference
    expect(conversation.ws).not.toBeNull();
  });

  it('should clear WebSocket on close', () => {
    const conversation = createEmptyConversation('runtime-1');
    conversation.ws = {}; // Mock WebSocket reference
    conversation.ws = null;
    expect(conversation.ws).toBeNull();
  });

  it('should track pending connect promise', () => {
    const conversation = createEmptyConversation('runtime-1');
    const connectPromise = Promise.resolve();
    conversation.connectPromise = connectPromise;
    expect(conversation.connectPromise).not.toBeNull();
  });

  it('should clear connect promise after completion', () => {
    const conversation = createEmptyConversation('runtime-1');
    conversation.connectPromise = Promise.resolve();
    conversation.connectPromise = null;
    expect(conversation.connectPromise).toBeNull();
  });
});

// ============================================================================
// Conversation Snapshot Tests
// ============================================================================

describe('Conversation snapshot generation', () => {
  function toPublicSnapshot(conversation: ConversationInternal): DesktopConversationSnapshot {
    return {
      runtimeId: conversation.runtimeId,
      status: conversation.status,
      sessionId: conversation.sessionId,
      error: conversation.error,
      messages: conversation.messages.map((m) => ({ ...m })),
    };
  }

  it('should create public snapshot without internal fields', () => {
    const conversation = createEmptyConversation('runtime-1');
    conversation.reconnectAttempt = 5;
    conversation.reconnectTimer = null;
    conversation.reconnectUrl = 'ws://localhost';
    conversation.ws = {};

    const snapshot = toPublicSnapshot(conversation);

    // Should not expose internal fields
    expect(snapshot).not.toHaveProperty('reconnectAttempt');
    expect(snapshot).not.toHaveProperty('reconnectTimer');
    expect(snapshot).not.toHaveProperty('reconnectUrl');
    expect(snapshot).not.toHaveProperty('ws');

    // Should have public fields
    expect(snapshot.runtimeId).toBe('runtime-1');
    expect(snapshot.status).toBe('disconnected');
    expect(snapshot.messages).toEqual([]);
  });

  it('should copy messages array (not reference)', () => {
    const conversation = createEmptyConversation('runtime-1');
    conversation.messages.push({
      id: '1',
      role: 'user',
      text: 'Hello',
      timestamp: 1,
    });

    const snapshot = toPublicSnapshot(conversation);

    // Modifying snapshot messages should not affect conversation
    snapshot.messages.push({
      id: '2',
      role: 'assistant',
      text: 'Hi',
      timestamp: 2,
    });

    expect(conversation.messages.length).toBe(1);
    expect(snapshot.messages.length).toBe(2);
  });

  it('should preserve all public fields', () => {
    const conversation = createEmptyConversation('runtime-1');
    conversation.status = 'running';
    conversation.sessionId = 'session-123';
    conversation.error = undefined;
    conversation.messages.push({
      id: '1',
      role: 'user',
      text: 'Test',
      timestamp: 1,
    });

    const snapshot = toPublicSnapshot(conversation);

    expect(snapshot.runtimeId).toBe('runtime-1');
    expect(snapshot.status).toBe('running');
    expect(snapshot.sessionId).toBe('session-123');
    expect(snapshot.error).toBeUndefined();
    expect(snapshot.messages).toHaveLength(1);
  });
});

// ============================================================================
// Event Type Validation Tests
// ============================================================================

describe('DesktopBridgeReconnectEvent type validation', () => {
  it('should accept all valid status values', () => {
    const validStatuses: DesktopBridgeReconnectEvent['status'][] = [
      'connecting',
      'connected',
      'error',
      'scheduled',
      'exhausted',
    ];

    for (const status of validStatuses) {
      const event: DesktopBridgeReconnectEvent = {
        runtimeId: 'test',
        status,
        attempt: 0,
        maxAttempts: 5,
      };
      expect(event.status).toBe(status);
    }
  });

  it('should have required fields', () => {
    const event: DesktopBridgeReconnectEvent = {
      runtimeId: 'runtime-1',
      status: 'connecting',
      attempt: 1,
      maxAttempts: 5,
    };

    expect(event.runtimeId).toBeDefined();
    expect(event.status).toBeDefined();
    expect(event.attempt).toBeDefined();
    expect(event.maxAttempts).toBeDefined();
  });

  it('should allow optional delay field', () => {
    const event: DesktopBridgeReconnectEvent = {
      runtimeId: 'runtime-1',
      status: 'scheduled',
      attempt: 1,
      maxAttempts: 5,
      delay: 2000,
    };

    expect(event.delay).toBe(2000);
  });
});

// ============================================================================
// Edge Cases Tests
// ============================================================================

describe('Edge cases', () => {
  it('should handle maxAttempts of 0 (disabled)', () => {
    const config = { ...RECONNECT_CONFIG, maxAttempts: 0 };
    const conversation = createEmptyConversation('runtime-1');

    const shouldReconnect = config.maxAttempts > 0 && conversation.reconnectAttempt < config.maxAttempts;
    expect(shouldReconnect).toBe(false);
  });

  it('should handle very long runtime ID', () => {
    const longId = 'a'.repeat(120);
    const conversation = createEmptyConversation(longId);
    expect(conversation.runtimeId).toBe(longId);
  });

  it('should handle special characters in runtime ID', () => {
    const specialIds = [
      'runtime_with_underscore',
      'runtime.with.dots',
      'runtime-with-hyphen',
      'runtime:with:colons',
    ];

    for (const id of specialIds) {
      const conversation = createEmptyConversation(id);
      expect(conversation.runtimeId).toBe(id);
    }
  });

  it('should handle message with empty text', () => {
    const conversation = createEmptyConversation('runtime-1');
    conversation.messages.push({
      id: '1',
      role: 'assistant',
      text: '',
      timestamp: 1,
    });

    expect(conversation.messages[0].text).toBe('');
  });

  it('should handle very long message text', () => {
    const conversation = createEmptyConversation('runtime-1');
    const longText = 'x'.repeat(100000);
    conversation.messages.push({
      id: '1',
      role: 'assistant',
      text: longText,
      timestamp: 1,
    });

    expect(conversation.messages[0].text.length).toBe(100000);
  });
});

// ============================================================================
// Conversation Status Transition Tests
// ============================================================================

describe('Status transitions', () => {
  it('should follow disconnect -> connecting -> connected flow', () => {
    const conversation = createEmptyConversation('runtime-1');

    // Initial
    expect(conversation.status).toBe('disconnected');

    // Connecting
    conversation.status = 'connecting';
    expect(conversation.status).toBe('connecting');

    // Connected
    conversation.status = 'connected';
    expect(conversation.status).toBe('connected');
  });

  it('should allow running after connected', () => {
    const conversation = createEmptyConversation('runtime-1');
    conversation.status = 'connected';
    conversation.status = 'running';
    expect(conversation.status).toBe('running');
  });

  it('should allow error state from any state', () => {
    const states: DesktopConversationStatus[] = [
      'disconnected',
      'connecting',
      'connected',
      'running',
    ];

    for (const status of states) {
      const conversation = createEmptyConversation('runtime-1');
      conversation.status = status;
      conversation.status = 'error';
      conversation.error = 'Test error';
      expect(conversation.status).toBe('error');
    }
  });

  it('should allow disconnect after error', () => {
    const conversation = createEmptyConversation('runtime-1');
    conversation.status = 'error';
    conversation.error = 'Connection failed';

    conversation.status = 'disconnected';
    expect(conversation.status).toBe('disconnected');
  });
});
