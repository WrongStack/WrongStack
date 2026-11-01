/**
 * What an HQ's sign-in settings add up to, in words.
 *
 * Reachable from the internet (public tunnel) raises the bar: a password is
 * the floor and two-factor the expectation. On a private network, a browser
 * token or a password is enough; nothing at all is never enough.
 */

export interface ProtectionInput {
  tokenMode: boolean;
  passwordMode: boolean;
  totpEnabled?: boolean | undefined;
  authKind?: 'token' | 'password' | 'open' | undefined;
  publicRelay?: boolean | undefined;
  secureCookies?: boolean | undefined;
}

export interface ProtectionSummary {
  level: 'strong' | 'weak' | 'exposed';
  headline: string;
  facts: string[];
  advice: string | null;
}

export function protectionSummary(status: ProtectionInput): ProtectionSummary {
  const totp = status.totpEnabled === true;
  const isPublic = status.publicRelay === true;
  const signIn = status.passwordMode
    ? totp
      ? 'Sign-in needs the password and an authenticator code.'
      : 'Sign-in needs the password.'
    : status.tokenMode
      ? 'Sign-in needs a browser token; there is no password.'
      : 'Sign-in needs nothing — HQ is open.';
  const facts = [
    signIn,
    status.passwordMode && status.tokenMode
      ? 'Browser tokens still work as a recovery path.'
      : null,
    isPublic
      ? 'The public tunnel is on: this HQ is reachable from the internet.'
      : 'The public tunnel is off: only this machine and its network can reach HQ.',
    status.authKind === 'token'
      ? 'This browser signed in with a token.'
      : status.authKind === 'password'
        ? 'This browser signed in with the password.'
        : null,
  ].filter((fact): fact is string => fact !== null);

  if (!status.passwordMode && !status.tokenMode) {
    return {
      level: 'exposed',
      headline: 'HQ is open to anyone who can reach it',
      facts,
      advice: 'Set a password below.',
    };
  }
  if (isPublic && !status.passwordMode) {
    return {
      level: 'exposed',
      headline: 'Reachable from the internet without a password',
      facts,
      advice: 'Set a password and turn on two-factor before sharing the public address.',
    };
  }
  if (isPublic && status.secureCookies === false) {
    return {
      level: 'weak',
      headline: 'Public, but sign-in cookies are not marked secure',
      facts,
      advice:
        'Serve the tunnel over HTTPS so the session cookie is sent only on secure connections.',
    };
  }
  if (isPublic && !totp) {
    return {
      level: 'weak',
      headline: 'Public, protected by the password alone',
      facts,
      advice: 'Turn on two-factor sign-in below.',
    };
  }
  return {
    level: 'strong',
    headline: isPublic ? 'Public, with password and two-factor' : 'Protected on a private network',
    facts,
    advice: null,
  };
}
