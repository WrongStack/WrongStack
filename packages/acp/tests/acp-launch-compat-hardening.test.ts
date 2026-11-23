import * as fs from 'node:fs/promises';
import { _filePermOps } from '@wrongstack/persistence';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prepareAcpLaunch } from '../src/client/acp-launch-compat.js';

/**
 * F48 (WS-045 class): prepareAcpLaunch writes the Copilot MCP configuration —
 * server env values and HTTP headers, which routinely carry API keys and
 * bearer tokens — via writeFile + mode 0o600 (a Windows no-op) with no
 * owner-only hardening. On Windows the config stayed readable by other local
 * accounts where inheritance was not owner-only. The config file is hardened
 * right after the write (best-effort), before the adapter is pointed at it.
 *
 * Deterministic call-site proof: inject the win32 seam (_filePermOps), capture
 * icacls for the mcp.json path taken from the returned --additional-mcp-config
 * argument.
 */
const icaclsCalls: Array<{ file: string; args: readonly string[] }> = [];

beforeEach(() => {
  icaclsCalls.length = 0;
  _filePermOps.platform = 'win32';
  _filePermOps.userInfo = (() => ({
    username: 'tester',
    uid: -1,
    gid: -1,
    homedir: 'C:\\Users\\tester',
    shell: null,
  })) as typeof _filePermOps.userInfo;
  _filePermOps.execFileAsync = async (file, args) => {
    icaclsCalls.push({ file, args });
    return { stdout: '', stderr: '' };
  };
});

afterEach(async () => {
  _filePermOps.platform = process.platform;
  _filePermOps.userInfo = undefined;
  _filePermOps.execFileAsync = undefined;
});

const hardened = (t: string) => icaclsCalls.some((c) => c.file === 'icacls' && c.args[0] === t);

describe('ACP launch MCP config owner-only hardening (F48)', () => {
  it('hardens the mcp.json holding server env/headers', async () => {
    const prepared = await prepareAcpLaunch({
      role: 'copilot',
      args: [],
      mcpServers: [
        {
          name: 'srv',
          command: 'srv-bin',
          args: [],
          env: [{ name: 'API_KEY', value: 'sk-secret' }],
        },
      ],
    } as never);
    const fileArg = prepared.args.find((a) => a.startsWith('@'));
    expect(fileArg, 'launch args reference the config file').toBeTruthy();
    const file = fileArg!.slice(1);
    expect(hardened(file), 'prepareAcpLaunch issues icacls for mcp.json').toBe(true);
    // Valid-input control: the config still carries the server env.
    const config = JSON.parse(await fs.readFile(file, 'utf8')) as {
      mcpServers: Record<string, { env: Record<string, string> }>;
    };
    expect(config.mcpServers['srv']!.env['API_KEY']).toBe('sk-secret');
    await prepared.dispose();
  });
});
