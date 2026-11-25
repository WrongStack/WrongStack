import { describe, expect, it } from 'vitest';
import { copilotBaseUrlFromToken } from '../src/github-copilot-token.js';

describe('copilotBaseUrlFromToken key boundary', () => {
  it('only matches exact proxy-ep fields delimited by start-of-string or semicolon', () => {
    expect(
      copilotBaseUrlFromToken(
        'not-proxy-ep=proxy.decoy.githubcopilot.com;proxy-ep=proxy.real.githubcopilot.com',
      ),
    ).toBe('https://api.real.githubcopilot.com');
    expect(copilotBaseUrlFromToken('not-proxy-ep=proxy.decoy.githubcopilot.com')).toBe(
      'https://api.individual.githubcopilot.com',
    );
  });
});
