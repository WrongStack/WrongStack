// Per-tool detail data for the built-in tool detail pages.
// Generated from the real tool definitions in @wrongstack/tools (name, description,
// inputSchema, selection boundaries). Keys match runtime-catalog.ts toolCatalog names.

import type { ToolDetail } from './tool-detail-types';

export const toolDetailsPart1: Record<string, ToolDetail> = {
  browser_open: {
    longDescription:
      'Open an isolated first-party Playwright browser session, optionally navigating to a URL.',
    params: [
      {
        name: 'url',
        type: 'string',
        description: 'Optional absolute http(s) URL.',
      },
      {
        name: 'width',
        type: 'integer',
      },
      {
        name: 'height',
        type: 'integer',
      },
      {
        name: 'trace',
        type: 'boolean',
        description: 'Capture a Playwright trace; defaults to true.',
      },
    ],
  },
  browser_status: {
    longDescription:
      'Check whether first-party Playwright Chromium is installed and ready to launch.',
    params: [],
  },
  browser_list: {
    longDescription:
      'List browser sessions owned by the current agent without exposing other agents sessions.',
    params: [],
  },
  browser_navigate: {
    longDescription: 'Navigate an owned browser session to an approved http(s) URL.',
    params: [
      {
        name: 'sessionId',
        type: 'string',
        required: true,
        description: 'Browser session id returned by browser_open.',
      },
      {
        name: 'url',
        type: 'string',
        required: true,
      },
    ],
  },
  browser_snapshot: {
    longDescription:
      'Return bounded accessibility state plus redacted console and network summaries.',
    params: [
      {
        name: 'sessionId',
        type: 'string',
        required: true,
        description: 'Browser session id returned by browser_open.',
      },
    ],
  },
  browser_screenshot: {
    longDescription:
      'Capture a page or element PNG and return sensitive artifact metadata with integrity hash.',
    params: [
      {
        name: 'sessionId',
        type: 'string',
        required: true,
        description: 'Browser session id returned by browser_open.',
      },
      {
        name: 'fullPage',
        type: 'boolean',
      },
      {
        name: 'selector',
        type: 'string',
      },
    ],
  },
  browser_click: {
    longDescription: 'Click an element in an owned browser session.',
    params: [
      {
        name: 'sessionId',
        type: 'string',
        required: true,
        description: 'Browser session id returned by browser_open.',
      },
      {
        name: 'selector',
        type: 'string',
        required: true,
      },
    ],
  },
  browser_type: {
    longDescription:
      'Fill an input in an owned browser session. Use secretEnv instead of text for credentials so values stay out of tool arguments and session audit.',
    params: [
      {
        name: 'sessionId',
        type: 'string',
        required: true,
        description: 'Browser session id returned by browser_open.',
      },
      {
        name: 'selector',
        type: 'string',
        required: true,
      },
      {
        name: 'text',
        type: 'string',
      },
      {
        name: 'secretEnv',
        type: 'string',
        description: 'Host environment variable resolved only at execution time.',
      },
    ],
  },
  browser_select: {
    longDescription: 'Select an option in an owned browser session.',
    params: [
      {
        name: 'sessionId',
        type: 'string',
        required: true,
        description: 'Browser session id returned by browser_open.',
      },
      {
        name: 'selector',
        type: 'string',
        required: true,
      },
      {
        name: 'value',
        type: 'string',
        required: true,
      },
    ],
  },
  browser_press: {
    longDescription: 'Press a keyboard key in an owned browser session.',
    params: [
      {
        name: 'sessionId',
        type: 'string',
        required: true,
        description: 'Browser session id returned by browser_open.',
      },
      {
        name: 'key',
        type: 'string',
        required: true,
      },
    ],
  },
  browser_hover: {
    longDescription: 'Hover an element in an owned browser session.',
    params: [
      {
        name: 'sessionId',
        type: 'string',
        required: true,
        description: 'Browser session id returned by browser_open.',
      },
      {
        name: 'selector',
        type: 'string',
        required: true,
      },
    ],
  },
  browser_drag: {
    longDescription: 'Drag one element to another in an owned browser session.',
    params: [
      {
        name: 'sessionId',
        type: 'string',
        required: true,
        description: 'Browser session id returned by browser_open.',
      },
      {
        name: 'from',
        type: 'string',
        required: true,
      },
      {
        name: 'to',
        type: 'string',
        required: true,
      },
    ],
  },
  browser_wait: {
    longDescription: 'Wait for an element or a bounded duration in an owned browser session.',
    params: [
      {
        name: 'sessionId',
        type: 'string',
        required: true,
        description: 'Browser session id returned by browser_open.',
      },
      {
        name: 'selector',
        type: 'string',
      },
      {
        name: 'timeoutMs',
        type: 'integer',
      },
    ],
  },
  browser_evaluate: {
    longDescription:
      'Evaluate bounded JavaScript in the page. Requires confirmation because page code is arbitrary.',
    params: [
      {
        name: 'sessionId',
        type: 'string',
        required: true,
        description: 'Browser session id returned by browser_open.',
      },
      {
        name: 'expression',
        type: 'string',
        required: true,
      },
    ],
  },
  browser_upload: {
    longDescription: 'Upload project-local files through a file input in an owned browser session.',
    params: [
      {
        name: 'sessionId',
        type: 'string',
        required: true,
        description: 'Browser session id returned by browser_open.',
      },
      {
        name: 'selector',
        type: 'string',
        required: true,
      },
      {
        name: 'files',
        type: 'string[]',
        required: true,
      },
    ],
  },
};
