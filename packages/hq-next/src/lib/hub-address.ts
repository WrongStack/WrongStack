/**
 * Whether the address this browser used for HQ is one another machine can
 * use. A loopback origin works here but means nothing on the next machine, so
 * the connect steps swap it for a placeholder and say why.
 */
export type HubAddressAdvice =
  | { kind: 'reachable' }
  | { kind: 'loopback'; host: string; example: string };

const LOOPBACK = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]|::1)$/i;

export function hubAddressAdvice(origin: string): HubAddressAdvice {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return { kind: 'reachable' };
  }
  if (!LOOPBACK.test(url.hostname)) return { kind: 'reachable' };
  const port = url.port === '' ? '' : `:${url.port}`;
  return {
    kind: 'loopback',
    host: url.hostname,
    example: `${url.protocol}//<hq-machine-address>${port}`,
  };
}
