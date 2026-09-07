// Split out of openai-codex.ts so the oauth entry (oauth/chatgpt.ts) can
// derive the account id without bundling the whole Codex provider.

const JWT_CLAIM_PATH = 'https://api.openai.com/auth';

interface CodexAuthClaim {
  chatgpt_account_id?: string;
  chatgpt_plan_type?: string;
}

/** Decode the `https://api.openai.com/auth` claim of an access-token JWT. */
function readAuthClaim(token: string): CodexAuthClaim | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    const auth = payload[JWT_CLAIM_PATH];
    return auth && typeof auth === 'object' ? (auth as CodexAuthClaim) : null;
  } catch {
    return null;
  }
}

/** Extract `chatgpt_account_id` from an access-token JWT, or null. */
export function extractAccountId(token: string): string | null {
  const id = readAuthClaim(token)?.chatgpt_account_id;
  return typeof id === 'string' && id.trim().length > 0 ? id : null;
}

/**
 * Extract the ChatGPT subscription tier (`plus`, `pro`, `team`, `enterprise`,
 * …) from an access-token JWT, or null.
 *
 * The quota headers report percentages, not allowances — "72% of the 5h
 * window" only becomes actionable when the reader knows which plan's window it
 * is. The claim is the cheapest source: it is already in the token we hold, so
 * no extra request is spent to learn it.
 */
export function extractPlanType(token: string): string | null {
  const plan = readAuthClaim(token)?.chatgpt_plan_type;
  return typeof plan === 'string' && plan.trim().length > 0 ? plan.trim() : null;
}
