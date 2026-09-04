// Split out of openai-codex.ts so the oauth entry (oauth/chatgpt.ts) can
// derive the account id without bundling the whole Codex provider.

const JWT_CLAIM_PATH = 'https://api.openai.com/auth';

/** Extract `chatgpt_account_id` from an access-token JWT, or null. */
export function extractAccountId(token: string): string | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    const auth = payload[JWT_CLAIM_PATH] as { chatgpt_account_id?: string } | undefined;
    const id = auth?.chatgpt_account_id;
    return typeof id === 'string' && id.trim().length > 0 ? id : null;
  } catch {
    return null;
  }
}
