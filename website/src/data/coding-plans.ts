export type ConnectionKind = 'oauth' | 'api-key';

export type CodingConnection = {
  id: string;
  name: string;
  vendor: string;
  logoUrl: string;
  logoAlt: string;
  kind: ConnectionKind;
  featured?: boolean;
  affiliateUrl?: string;
  subscribeUrl: string;
  docsUrl: string;
  badge: string;
  billing: string;
  headline: string;
  summary: string;
  bestFor: string;
  providerId: string;
  endpoint: string;
  keySource: string;
  modelHint: string;
  authCommand: string;
  runCommand: string;
  steps: readonly string[];
  note?: string;
};

/**
 * Keep subscription/referral URLs here so an affiliate change never requires
 * touching page markup. Provider ids and endpoints mirror the runtime catalog.
 */
export const codingConnections: readonly CodingConnection[] = [
  {
    id: 'chatgpt-codex',
    name: 'ChatGPT + Codex',
    vendor: 'OpenAI',
    logoUrl: 'https://learn.chatgpt.com/favicon.png',
    logoAlt: 'OpenAI',
    kind: 'oauth',
    featured: true,
    subscribeUrl: 'https://chatgpt.com/pricing',
    docsUrl: 'https://learn.chatgpt.com/docs/auth#openai-authentication',
    badge: 'Recommended first connection',
    billing: 'Your ChatGPT subscription',
    headline: 'Already have Codex access? Connect your ChatGPT account.',
    summary:
      'WrongStack opens the browser-based ChatGPT sign-in flow, stores the refreshed credential in the encrypted local vault and adds openai-codex as a selectable provider.',
    bestFor: 'The quickest route for an existing ChatGPT account with Codex access.',
    providerId: 'openai-codex',
    endpoint: 'https://chatgpt.com/backend-api/codex',
    keySource: 'No API key — browser OAuth',
    modelHint: 'Current Codex models from the authenticated account',
    authCommand: 'wstack auth login chatgpt',
    runCommand: 'wstack --provider openai-codex --model gpt-6-astra',
    steps: [
      'Run the login command from any terminal.',
      'Finish the ChatGPT sign-in and account selection in your browser.',
      'Return to WrongStack and choose the openai-codex provider in the model picker.',
    ],
    note: 'Subscription availability and limits follow the signed-in ChatGPT workspace. Review provider terms before using subscription credentials in a third-party client; an OpenAI Platform API key remains the standard route for programmatic API usage.',
  },
  {
    id: 'opencode-go',
    name: 'OpenCode Go',
    vendor: 'OpenCode',
    logoUrl: 'https://opencode.ai/favicon-96x96-v3.png',
    logoAlt: 'OpenCode',
    kind: 'api-key',
    affiliateUrl: 'https://opencode.ai/go?ref=6VZAER87H4',
    subscribeUrl: 'https://opencode.ai/go',
    docsUrl: 'https://opencode.ai/docs/go/',
    badge: 'Low-cost subscription',
    billing: 'Subscription + usage limits',
    headline: 'One affordable key for popular open coding models.',
    summary:
      'Go is OpenCode’s subscription route for a focused set of open coding models. The same OpenCode account issues the API key WrongStack stores under opencode-go.',
    bestFor: 'High-volume everyday coding with a predictable subscription.',
    providerId: 'opencode-go',
    endpoint: 'https://opencode.ai/zen/go/v1',
    keySource: 'OpenCode account → API keys',
    modelHint: 'GLM, Kimi, MiniMax, Qwen, DeepSeek and other Go models',
    authCommand: 'wstack auth opencode-go',
    runCommand: 'wstack --provider opencode-go --model glm-5.2',
    steps: [
      'Create an OpenCode account and subscribe to Go.',
      'Create or copy the OpenCode API key from your account.',
      'Run the auth command, paste the key and select an opencode-go model.',
    ],
  },
  {
    id: 'opencode-zen',
    name: 'OpenCode Zen',
    vendor: 'OpenCode',
    logoUrl: 'https://opencode.ai/favicon-96x96-v3.png',
    logoAlt: 'OpenCode',
    kind: 'api-key',
    subscribeUrl: 'https://opencode.ai/zen',
    docsUrl: 'https://opencode.ai/docs/zen/',
    badge: 'Curated model gateway',
    billing: 'Prepaid, pay as you go',
    headline: 'A curated gateway when you want model choice without provider sprawl.',
    summary:
      'Zen exposes coding-tested model routes behind one OpenCode key. WrongStack connects through the openai-compatible opencode provider and keeps every model selectable.',
    bestFor: 'Trying multiple coding models behind a single balance and key.',
    providerId: 'opencode',
    endpoint: 'https://opencode.ai/zen/v1',
    keySource: 'OpenCode Zen → API keys',
    modelHint: 'Curated OpenAI, Anthropic and open-model routes',
    authCommand: 'wstack auth opencode',
    runCommand: 'wstack --provider opencode --model minimax-m3',
    steps: [
      'Sign in to OpenCode Zen and add credit or billing details.',
      'Create an API key in the Zen account area.',
      'Save it with the opencode provider and choose a model from the live catalog.',
    ],
  },
  {
    id: 'minimax-token-plan',
    name: 'MiniMax Token Plan',
    vendor: 'MiniMax',
    logoUrl: 'https://file.cdn.minimax.io/public/25289820-59cd-4365-9829-a3f32b365451.ico',
    logoAlt: 'MiniMax',
    kind: 'api-key',
    affiliateUrl: 'https://platform.minimax.io/subscribe/token-plan?code=JrA4R9QAEn&source=link',
    subscribeUrl: 'https://platform.minimax.io/subscribe/token-plan',
    docsUrl: 'https://platform.minimax.io/docs/token-plan/quickstart',
    badge: 'Formerly Coding Plan',
    billing: 'Fixed Token Plan quota',
    headline: 'MiniMax coding models through a dedicated plan key.',
    summary:
      'The current Token Plan extends the former Coding Plan. Its sk-cp key is separate from a pay-as-you-go key and connects to WrongStack through the Anthropic-compatible runtime family.',
    bestFor: 'Long agent sessions, large contexts and MiniMax-first model routing.',
    providerId: 'minimax-coding-plan',
    endpoint: 'https://api.minimax.io/anthropic/v1',
    keySource: 'Billing → Token Plan → Token Plan key',
    modelHint: 'MiniMax-M3, M2.7 and high-speed variants when included',
    authCommand: 'wstack auth minimax-coding-plan',
    runCommand: 'wstack --provider minimax-coding-plan --model MiniMax-M3',
    steps: [
      'Subscribe to a MiniMax Token Plan on the API platform.',
      'Create the dedicated Token Plan key; do not substitute a standard pay-as-you-go key.',
      'Save it under minimax-coding-plan and select an included MiniMax model.',
    ],
  },
  {
    id: 'zai-coding-plan',
    name: 'GLM Coding Plan',
    vendor: 'Z.AI',
    logoUrl: 'https://z-cdn.chatglm.cn/z-ai/static/logo.svg',
    logoAlt: 'Z.AI',
    kind: 'api-key',
    affiliateUrl: 'https://z.ai/subscribe?ic=JQZ7TPPRA6',
    subscribeUrl: 'https://z.ai/subscribe',
    docsUrl: 'https://docs.z.ai/devpack/quick-start',
    badge: 'GLM subscription',
    billing: 'Coding Plan quota',
    headline: 'A dedicated GLM endpoint for coding-agent workloads.',
    summary:
      'Coding Plan keys use a different API route from Z.AI’s general platform. WrongStack’s zai-coding-plan entry targets that coding endpoint directly.',
    bestFor: 'GLM-focused coding with subscription quotas and optional plan MCP services.',
    providerId: 'zai-coding-plan',
    endpoint: 'https://api.z.ai/api/coding/paas/v4',
    keySource: 'Coding Plan overview → create API key',
    modelHint: 'Current GLM Coding Plan models from the live catalog',
    authCommand: 'wstack auth zai-coding-plan',
    runCommand: 'wstack --provider zai-coding-plan --model glm-5.2',
    steps: [
      'Register or sign in to Z.AI and subscribe to GLM Coding Plan.',
      'Create the Individual or Team Coding Plan key from the matching plan area.',
      'Save it as zai-coding-plan so requests use the coding endpoint, not the general API.',
    ],
  },
  {
    id: 'kimi-for-coding',
    name: 'Kimi Code',
    vendor: 'Kimi',
    logoUrl: 'https://www.kimi.com/favicon.ico',
    logoAlt: 'Kimi',
    kind: 'api-key',
    subscribeUrl: 'https://www.kimi.com/membership/pricing',
    docsUrl: 'https://www.kimi.com/code/docs/en/',
    badge: 'Membership benefit',
    billing: 'Kimi membership quota',
    headline: 'Use your Kimi coding benefit in the agent you already run.',
    summary:
      'Kimi members can create a dedicated coding API key for third-party agents. WrongStack connects through kimi-for-coding and can use the stable standard or high-speed model id.',
    bestFor: 'Kimi-first coding, fast output and a membership-based quota.',
    providerId: 'kimi-for-coding',
    endpoint: 'https://api.kimi.com/coding/v1',
    keySource: 'Kimi Code Console → Create API key',
    modelHint: 'kimi-for-coding; HighSpeed requires an eligible plan',
    authCommand: 'wstack auth kimi-for-coding',
    runCommand: 'wstack --provider kimi-for-coding --model kimi-for-coding',
    steps: [
      'Subscribe to a Kimi membership that includes Kimi Code.',
      'Create a Kimi Code key in the console and copy it when shown.',
      'Save it under kimi-for-coding and choose the standard or eligible high-speed model.',
    ],
  },
] as const;

export const chatGptConnection = codingConnections[0];
export const apiKeyConnections = codingConnections.filter((item) => item.kind === 'api-key');

export function connectionUrl(connection: CodingConnection) {
  return connection.affiliateUrl ?? connection.subscribeUrl;
}
