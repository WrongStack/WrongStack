/**
 * The Codex / "Sign in with ChatGPT" OAuth protocol must have exactly one
 * definition.
 *
 * It had three: the CLI terminal flow, the headless WebUI flow
 * (`providers/src/oauth/chatgpt.ts`), and the runtime provider's refresh path
 * (`providers/src/openai-codex.ts`, whose header said in as many words that it
 * was "mirror[ing] packages/cli auth-menu/openai-codex-oauth"). That is what
 * let the OAuth abort-listener leak sit in two flows while a third in the same
 * directory was already correct — nothing made the copies agree, so fixing one
 * left the others quietly broken.
 *
 * These tests assert the property that prevents the regression: the wire
 * constants appear literally in one file, and the entry points every surface
 * uses resolve to the same function object.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { refreshCodexAccessToken } from '@wrongstack/providers';
import * as protocol from '@wrongstack/providers/oauth';
import { describe, expect, it } from 'vitest';
import * as cliCodex from '../src/auth-menu/openai-codex-oauth.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** Every non-declaration `.ts` source file under any package's `src` tree. */
function sourceFiles(): string[] {
  const out: string[] = [];
  const packagesDir = path.join(repoRoot, 'packages');
  for (const pkg of fs.readdirSync(packagesDir)) {
    const src = path.join(packagesDir, pkg, 'src');
    if (!fs.existsSync(src)) continue;
    const stack = [src];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(full);
      }
    }
  }
  return out;
}

/** Files whose source contains `needle`, excluding pure comment mentions. */
function filesContaining(needle: string): string[] {
  return sourceFiles().filter((file) => {
    const text = fs.readFileSync(file, 'utf8');
    return text
      .split('\n')
      .some(
        (line) =>
          line.includes(needle) &&
          !line.trimStart().startsWith('*') &&
          !line.trimStart().startsWith('//'),
      );
  });
}

describe('Codex OAuth wire constants are defined once', () => {
  it.each([
    ['the OAuth client id', 'app_EMoamEEZ73f0CkXaXp7hrann'],
    // The endpoints are composed from this base, so the base is the thing that
    // must not be re-typed; `/oauth/token` alone would never match a literal.
    ['the OAuth host', "'https://auth.openai.com'"],
    ['the ChatGPT backend base', "'https://chatgpt.com/backend-api'"],
  ])('%s appears in exactly one source file', (_label, needle) => {
    const hits = filesContaining(needle).map((f) => path.relative(repoRoot, f).replace(/\\/g, '/'));
    expect(hits).toEqual(['packages/providers/src/oauth/codex-protocol.ts']);
  });
});

describe('the OAuth loopback callback server is defined once', () => {
  it.each([
    ['the callback HTTP listener', 'createServer('],
    ['the callback page renderer', 'function callbackHtml'],
  ])('%s exists in exactly one OAuth source file', (_label, needle) => {
    const hits = filesContaining(needle)
      .map((f) => path.relative(repoRoot, f).replace(/\\/g, '/'))
      // Scope to the OAuth flows: plenty of unrelated modules stand up servers.
      .filter((f) => f.includes('/oauth/') || f.includes('/auth-menu/'));
    expect(hits).toEqual(['packages/providers/src/oauth/shared.ts']);
  });

  it('the terminal browser opener exists once on the CLI side', () => {
    const hits = filesContaining('function openBrowser')
      .map((f) => path.relative(repoRoot, f).replace(/\\/g, '/'))
      .filter((f) => f.startsWith('packages/cli/'));
    // The WebUI server keeps its own opener on purpose — it detaches and
    // registers the pid as protected, which the CLI flows must not do.
    expect(hits).toEqual(['packages/cli/src/auth-menu/loopback-server.ts']);
  });
});

describe('every surface resolves to the same implementation', () => {
  it('the CLI terminal flow re-exports the shared protocol, it does not re-implement it', () => {
    expect(cliCodex.buildAuthorizeUrl).toBe(protocol.buildCodexAuthorizeUrl);
    expect(cliCodex.exchangeAuthorizationCode).toBe(protocol.exchangeCodexAuthorizationCode);
    expect(cliCodex.refreshCodexToken).toBe(protocol.refreshCodexTokens);
    expect(cliCodex.generatePkce).toBe(protocol.generatePkce);
    expect(cliCodex.parseAuthorizationInput).toBe(protocol.parseAuthorizationInput);
    expect(cliCodex.extractAccountId).toBe(protocol.extractAccountId);
    expect(cliCodex.resolveCodexModels).toBe(protocol.resolveCodexModels);
    expect(cliCodex.fetchCodexModels).toBe(protocol.fetchCodexModels);
    expect(cliCodex.filterCurrentCodexModelIds).toBe(protocol.filterCurrentCodexModelIds);
    expect(cliCodex.CODEX_PROVIDER_ID).toBe(protocol.CODEX_PROVIDER_ID);
    expect(cliCodex.CODEX_BASE_URL).toBe(protocol.CODEX_BASE_URL);
  });

  it('the runtime provider refresh path goes through the shared protocol', async () => {
    // `refreshCodexAccessToken` is a named alias, not the same object — assert
    // it delegates by observing the request it makes.
    const calls: Array<{ url: string; body: string }> = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body ?? '') });
      return new Response(
        JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_in: 60 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
    try {
      await refreshCodexAccessToken('the-refresh-token');
    } finally {
      globalThis.fetch = original;
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(protocol.CODEX_TOKEN_URL);
    expect(calls[0]!.body).toContain(`client_id=${protocol.CODEX_CLIENT_ID}`);
    expect(calls[0]!.body).toContain('grant_type=refresh_token');
  });

  it('the authorize URL is identical whichever entry point builds it', () => {
    const fromCli = cliCodex.buildAuthorizeUrl('CH', 'ST', 1455);
    const fromProtocol = protocol.buildCodexAuthorizeUrl('CH', 'ST', 1455);
    expect(fromCli).toBe(fromProtocol);
    const url = new URL(fromCli);
    expect(url.searchParams.get('client_id')).toBe(protocol.CODEX_CLIENT_ID);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('redirect_uri')).toBe(protocol.codexRedirectUri(1455));
  });
});
