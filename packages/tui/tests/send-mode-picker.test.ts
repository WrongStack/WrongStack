import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import {
  formatSendModeMessagePreview,
  nextSendModeIndex,
  SEND_MODE_OPTIONS,
  type SendModeKey,
  SendModePicker,
  sendModeFromKey,
} from '../src/components/send-mode-picker.js';
import { Box } from '../src/ink.js';
import { renderRealTty, settle } from './helpers/real-tty.js';

const KEY: SendModeKey = {};
const k = (over: Partial<SendModeKey>): SendModeKey => ({ ...KEY, ...over });

describe('SEND_MODE_OPTIONS', () => {
  it('lists queue / btw / steer with queue first (default highlight)', () => {
    expect(SEND_MODE_OPTIONS.map((o) => o.mode)).toEqual(['queue', 'btw', 'steer']);
    expect(SEND_MODE_OPTIONS.map((o) => o.key)).toEqual(['q', 'b', 's']);
  });
});

describe('nextSendModeIndex', () => {
  const len = SEND_MODE_OPTIONS.length; // 3
  it('moves down and up within range', () => {
    expect(nextSendModeIndex(0, 1, len)).toBe(1);
    expect(nextSendModeIndex(1, 1, len)).toBe(2);
  });
  it('wraps around at both ends', () => {
    expect(nextSendModeIndex(2, 1, len)).toBe(0);
    expect(nextSendModeIndex(0, -1, len)).toBe(2);
  });
  it('is safe for an empty list', () => {
    expect(nextSendModeIndex(0, 1, 0)).toBe(0);
  });
});

describe('sendModeFromKey', () => {
  it('quick keys pick their mode regardless of selection', () => {
    expect(sendModeFromKey('q', KEY, 2)).toBe('queue');
    expect(sendModeFromKey('b', KEY, 0)).toBe('btw');
    expect(sendModeFromKey('s', KEY, 0)).toBe('steer');
  });

  it('quick keys are case-insensitive and tolerate surrounding space', () => {
    expect(sendModeFromKey('B', KEY, 0)).toBe('btw');
    expect(sendModeFromKey(' s ', KEY, 0)).toBe('steer');
  });

  it('Enter selects the highlighted option', () => {
    expect(sendModeFromKey('', k({ return: true }), 0)).toBe('queue');
    expect(sendModeFromKey('', k({ return: true }), 1)).toBe('btw');
    expect(sendModeFromKey('', k({ return: true }), 2)).toBe('steer');
  });

  it('Esc cancels (caller restores the draft to the composer)', () => {
    expect(sendModeFromKey('', k({ escape: true }), 1)).toBe('cancel');
  });

  it('arrows and unrelated keys return null (caller moves selection)', () => {
    expect(sendModeFromKey('', k({ upArrow: true }), 0)).toBeNull();
    expect(sendModeFromKey('', k({ downArrow: true }), 0)).toBeNull();
    expect(sendModeFromKey('x', KEY, 0)).toBeNull();
  });
});

describe('formatSendModeMessagePreview', () => {
  it('collapses whitespace so multi-line prompts fit in the picker', () => {
    expect(formatSendModeMessagePreview('first line\n\n  second\tline')).toBe(
      'first line second line',
    );
  });

  it('truncates long prompts with an ellipsis', () => {
    expect(formatSendModeMessagePreview('abcdefghijklmnopqrstuvwxyz', 10)).toBe('abcdefghi…');
  });
});

describe('SendModePicker render', () => {
  it('shows Esc as returning to the input, not queueing', () => {
    const view = render(
      React.createElement(SendModePicker, {
        selected: 0,
        messagePreview: 'hello',
        onMove: () => {},
        onSelect: () => {},
      }),
    );
    const frame = view.lastFrame() ?? '';

    expect(frame).toContain('Esc → back to input');
    expect(frame).not.toContain('Esc → queue');

    view.unmount();
  });

  it('keeps title, modes and Escape hint visible in a 40x8 bottom region', async () => {
    const longPreview = `${'ship the refactor to the staging fleet and keep the old queue intact while the reviewer checks the migration '.repeat(3)}`;
    const view = renderRealTty(
      React.createElement(
        Box,
        { flexDirection: 'column', height: 8, overflowY: 'hidden', justifyContent: 'flex-end' },
        React.createElement(SendModePicker, {
          selected: 0,
          messagePreview: longPreview,
          onMove: () => {},
          onSelect: () => {},
        }),
      ),
      { columns: 40, rows: 8 },
    );
    try {
      await settle();
      const frame = view.lastFrame();
      expect(frame).toContain('Deliver this message how?');
      expect(frame).toContain('Message:');
      expect(frame).toContain('Queue');
      expect(frame).toContain('By the way');
      expect(frame).toContain('Steer');
      expect(frame).toContain('Esc → back to input');
    } finally {
      view.unmount();
    }
  });
});
