import { randomUUID } from 'node:crypto';
import * as net from 'node:net';
import * as path from 'node:path';
import type { Context } from '@wrongstack/core/agent';
import { isPrivateIPv4, isPrivateIPv6 } from '@wrongstack/core/utils';
import { browserPrivateOrigins, setBrowserPrivateOrigin } from './policy.js';
import { isLoopbackHostname, isPrivateOriginApproved, LOOPBACK_ALLOWANCE } from './security.js';

const QUESTION_ID = 'private_origin';

/**
 * Ask the person, through the host's user-input form (TUI and WebUI alike),
 * whether a private/loopback origin the browser is about to open may be
 * allowed for this project, and save the answer as `/browser allow` would.
 * Refusing to open it and telling them to type a slash command meant a WebUI
 * user approved `browser_open`, then got an error naming a command to run.
 *
 * Only a host that is literally loopback or a literal private IP is offered:
 * a public name resolving to a private address is the DNS-rebinding shape and
 * keeps the plain refusal. No answer (no surface, unattended autonomy) or a
 * refusal leaves the policy untouched, so the guard refuses as before.
 */
export async function promptForPrivateOrigin(
  ctx: Context,
  rawUrl: string | undefined,
  signal: AbortSignal,
): Promise<void> {
  if (!rawUrl || typeof ctx.requestUserInput !== 'function') return;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
  const loopback = isLoopbackHostname(url.hostname);
  if (!loopback && !isPrivateLiteral(url.hostname)) return;
  const root = path.resolve(ctx.projectRoot ?? ctx.cwd ?? process.cwd());
  if (isPrivateOriginApproved(url, browserPrivateOrigins(root))) return;

  const response = await ctx.requestUserInput(
    {
      id: `browser_private_origin_${randomUUID()}`,
      title: 'Allow a local address in the browser?',
      description: `The agent wants to open ${url.origin}, which is a ${loopback ? 'loopback' : 'private network'} address. The browser refuses these unless you allow them for this project.`,
      submitLabel: 'Apply',
      tabs: [
        {
          id: 'origin',
          label: 'Browser',
          questions: [
            {
              id: QUESTION_ID,
              prompt: `Allow ${url.origin}?`,
              kind: 'single_select',
              required: true,
              options: [
                {
                  id: 'origin',
                  label: `Allow ${url.origin}`,
                  description: 'Saved for this project; same as /browser allow.',
                },
                ...(loopback
                  ? [
                      {
                        id: LOOPBACK_ALLOWANCE,
                        label: 'Allow every local port',
                        description:
                          'localhost, 127.0.0.0/8 and ::1 on any port, for this project.',
                      },
                    ]
                  : []),
                { id: 'deny', label: "Don't allow", description: 'The browser call fails.' },
              ],
              recommendedOptionIds: ['origin'],
            },
          ],
        },
      ],
    },
    signal,
  );
  if (response?.status !== 'submitted') return;
  const choice = response.answers.find((answer) => answer.questionId === QUESTION_ID)
    ?.selectedOptionIds[0];
  if (choice === 'origin') await setBrowserPrivateOrigin(root, url.origin, true);
  else if (choice === LOOPBACK_ALLOWANCE && loopback)
    await setBrowserPrivateOrigin(root, LOOPBACK_ALLOWANCE, true);
}

function isPrivateLiteral(rawHostname: string): boolean {
  const host =
    rawHostname.startsWith('[') && rawHostname.endsWith(']')
      ? rawHostname.slice(1, -1)
      : rawHostname;
  const family = net.isIP(host);
  if (family === 4) return isPrivateIPv4(host);
  if (family === 6) return isPrivateIPv6(host);
  return false;
}
