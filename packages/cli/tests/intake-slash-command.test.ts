import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Context } from '@wrongstack/core/agent';
import { resolveWstackPaths } from '@wrongstack/core/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SlashCommandContext } from '../src/slash-commands/command-context.js';
import { buildIntakeCommand } from '../src/slash-commands/intake.js';

const REQUEST_TEXT = 'Add email-based password reset so users can recover access.';

describe('/intake command', () => {
  let root: string;
  let globalRoot: string;
  let intakeDir: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-intake-slash-'));
    globalRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-intake-global-'));
    const paths = resolveWstackPaths({ projectRoot: root, globalRoot });
    intakeDir = paths.projectRequirementIntakes;
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(globalRoot, { recursive: true, force: true }).catch(() => undefined);
  });

  function command(context?: SlashCommandContext['context']) {
    const opts = {
      projectRoot: root,
      paths: resolveWstackPaths({ projectRoot: root, globalRoot }),
      context,
    } as SlashCommandContext;
    return buildIntakeCommand(opts);
  }

  it('creates and submits an intake record from given text', { timeout: 5000 }, async () => {
    const result = await command().run(REQUEST_TEXT);
    const message = result?.message ?? '';
    expect(message).toContain('reqi_');
    expect(message).toContain('submitted');
    expect(message).toContain(intakeDir);

    // The record file exists and preserves the exact original request.
    const entries = await fs.readdir(intakeDir);
    const recordFile = entries.find(
      (entry) => entry.startsWith('reqi_') && entry.endsWith('.json'),
    );
    expect(recordFile).toBeDefined();
    const record = JSON.parse(await fs.readFile(path.join(intakeDir, recordFile!), 'utf8')) as {
      originalRequest: string;
      status: string;
    };
    expect(record.originalRequest).toBe(REQUEST_TEXT);
    expect(record.status).toBe('submitted');
  });

  it('falls back to the most recent user prompt when no text is given', {
    timeout: 5000,
  }, async () => {
    const context = {
      messages: [
        { role: 'assistant', content: 'let me check' },
        { role: 'user', content: '  ' },
        { role: 'user', content: 'Build a dashboard for intake metrics' },
      ],
    } as unknown as Context;
    const result = await command(context).run('');
    const message = result?.message ?? '';
    expect(message).toContain('reqi_');
    expect(message).toContain('submitted');

    const entries = await fs.readdir(intakeDir);
    const recordFile = entries.find(
      (entry) => entry.startsWith('reqi_') && entry.endsWith('.json'),
    );
    const record = JSON.parse(await fs.readFile(path.join(intakeDir, recordFile!), 'utf8')) as {
      originalRequest: string;
    };
    expect(record.originalRequest).toBe('Build a dashboard for intake metrics');
  });

  it('shows usage when there is no text and no session prompt', { timeout: 5000 }, async () => {
    const result = await command().run('');
    expect(result?.message).toContain('Nothing to intake');
  });
});
