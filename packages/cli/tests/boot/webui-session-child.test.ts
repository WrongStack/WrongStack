import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  parseWebuiSessionChildOptions,
  WEBUI_SESSION_CHILD_CAPABILITIES,
  WEBUI_SESSION_CHILD_PROTOCOL_VERSION,
  writeWebuiSessionChildError,
  writeWebuiSessionChildReady,
  type WebuiSessionChildReadyPayload,
} from '../../src/boot/webui-session-child.js';

describe('webui session child contract', () => {
  let root: string;
  let projectRoot: string;
  let readyFile: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-webui-child-'));
    projectRoot = path.join(root, 'project');
    readyFile = path.join(root, 'ready', 'child.json');
    await fs.mkdir(projectRoot, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('returns null when the internal child flag is absent', () => {
    expect(parseWebuiSessionChildOptions({ webui: true })).toBeNull();
  });

  it('parses and validates the internal child launch flags', () => {
    const parsed = parseWebuiSessionChildOptions({
      'webui-session-child': true,
      'project-root': projectRoot,
      'working-dir': projectRoot,
      'parent-pid': '1234',
      'parent-shell-id': 'shell-a',
      'runtime-id': 'runtime-a',
      'ready-file': readyFile,
      'webui-port': '4567',
      'webui-token': 'token-a',
      'webui-require-token': 'true',
      'strict-port': true,
    });

    expect(parsed).toMatchObject({
      enabled: true,
      projectRoot,
      workingDir: projectRoot,
      parentPid: 1234,
      parentShellId: 'shell-a',
      runtimeId: 'runtime-a',
      readyFile,
      port: 4567,
      token: 'token-a',
      requireToken: true,
      strictPort: true,
      attachable: true,
      protocolVersion: WEBUI_SESSION_CHILD_PROTOCOL_VERSION,
    });
  });

  it('requires resume when a session id is supplied', () => {
    expect(() =>
      parseWebuiSessionChildOptions({
        'webui-session-child': true,
        'project-root': projectRoot,
        'working-dir': projectRoot,
        'parent-pid': '1234',
        'parent-shell-id': 'shell-a',
        'runtime-id': 'runtime-a',
        'ready-file': readyFile,
        'session-id': 'sess-a',
      }),
    ).toThrow(/--session-id requires --resume/);
  });

  it('rejects a working directory outside the project root', () => {
    expect(() =>
      parseWebuiSessionChildOptions({
        'webui-session-child': true,
        'project-root': projectRoot,
        'working-dir': root,
        'parent-pid': '1234',
        'parent-shell-id': 'shell-a',
        'runtime-id': 'runtime-a',
        'ready-file': readyFile,
      }),
    ).toThrow(/--working-dir must be inside --project-root/);
  });

  it('writes the ready payload atomically as JSON', async () => {
    const payload: WebuiSessionChildReadyPayload = {
      type: 'webui.session_child.ready',
      protocolVersion: WEBUI_SESSION_CHILD_PROTOCOL_VERSION,
      runtime: {
        role: 'session-child',
        runtimeId: 'runtime-a',
        pid: 1234,
        parentPid: 123,
        parentShellId: 'shell-a',
        startedAt: '2026-08-08T00:00:00.000Z',
      },
      project: {
        projectRoot,
        workingDir: projectRoot,
        projectSlug: 'project',
        projectName: 'project',
      },
      session: {
        sessionId: 'sess-a',
        created: true,
        resumed: false,
        provider: 'test-provider',
        model: 'test-model',
      },
      endpoint: {
        surface: 'webui',
        host: '127.0.0.1',
        httpPort: 4567,
        url: 'http://127.0.0.1:4567',
        requireToken: true,
        auth: { scheme: 'registry-token', tokenPresent: true, token: 'token-a' },
      },
      registry: {
        webuiInstanceRegistered: true,
        sessionRegistered: true,
      },
      capabilities: [...WEBUI_SESSION_CHILD_CAPABILITIES],
    };

    await writeWebuiSessionChildReady(readyFile, payload);

    await expect(fs.readFile(readyFile, 'utf8').then(JSON.parse)).resolves.toMatchObject({
      type: 'webui.session_child.ready',
      runtime: { runtimeId: 'runtime-a' },
      session: { sessionId: 'sess-a' },
      endpoint: { httpPort: 4567 },
    });
  });

  it('writes structured startup errors', async () => {
    await writeWebuiSessionChildError(readyFile, {
      runtimeId: 'runtime-a',
      parentShellId: 'shell-a',
      phase: 'validate_args',
      recoverable: false,
      error: new Error('bad child args'),
    });

    await expect(fs.readFile(readyFile, 'utf8').then(JSON.parse)).resolves.toMatchObject({
      type: 'webui.session_child.error',
      protocolVersion: WEBUI_SESSION_CHILD_PROTOCOL_VERSION,
      runtimeId: 'runtime-a',
      parentShellId: 'shell-a',
      phase: 'validate_args',
      recoverable: false,
      message: 'bad child args',
    });
  });
});
