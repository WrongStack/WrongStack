import type { ServerMessage } from '../types.js';

export interface StatusNoticeProjection {
  text: string;
  tone: 'warning' | 'error';
}

function compactLine(value: unknown, prefix = ''): string {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  const combined = `${prefix}${text}`.trim();
  return combined.length > 180 ? `${combined.slice(0, 177)}…` : combined;
}

export function projectStatusNotice(message: ServerMessage): StatusNoticeProjection | null {
  const payload = message.payload ?? {};
  switch (message.type) {
    case 'sessions.list': {
      const text = compactLine(payload['error'], 'Sessions · ');
      return text ? { text, tone: 'error' } : null;
    }
    case 'key.operation_result': {
      if (payload['success'] !== false) return null;
      const text = compactLine(payload['message']);
      return { text: text || 'Operation failed', tone: 'error' };
    }
    case 'provider.error': {
      const text = compactLine(payload['description'], 'Provider · ');
      return {
        text: text || 'Provider request failed',
        tone: payload['retryable'] === true ? 'warning' : 'error',
      };
    }
    case 'provider.stream_error': {
      const text = compactLine(payload['message'], 'Stream · ');
      return { text: text || 'Provider stream interrupted', tone: 'warning' };
    }
    default:
      return null;
  }
}
