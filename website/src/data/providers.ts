/* =========================================================================
   Provider gallery data. Mirrors real repo sources, NOT the full ~140 dynamic
   models.dev catalog (which is fetched at boot and has no static per-provider
   record). Keep these in sync with their sources:
   - curatedProviders  → packages/webui/public/providers.json
   - oauthProviders    → packages/core/src/models/models-registry.ts (FAMILY_BY_PROVIDER_ID)
                         + packages/providers/src/oauth/*
   - localProviders    → packages/cli/src/auth-menu/local-presets.ts (LOCAL_LLM_PRESETS)

   Logo URLs and signup links are website-side presentation; signup URLs
   resolve from coding-plans.ts so a vendor change stays single-source.
   ========================================================================= */

import { codingConnections } from './coding-plans';

export type WireFamily = 'anthropic' | 'openai' | 'openai-compatible' | 'google';

export const familyLabels: Record<WireFamily, string> = {
  anthropic: 'Anthropic wire',
  openai: 'OpenAI wire',
  'openai-compatible': 'OpenAI-compatible',
  google: 'Google wire',
};

export interface CuratedProvider {
  id: string;
  name: string;
  vendor: string;
  description: string;
  logoUrl: string;
  logoAlt: string;
  family: WireFamily;
  keyPlaceholder: string;
  /** Subscription sign-up link where one exists (resolved from coding-plans). */
  signupUrl?: string;
}

/** Resolve a coding connection's official subscription sign-up URL. */
function signupUrlFor(connectionId: string): string | undefined {
  const connection = codingConnections.find((item) => item.id === connectionId);
  return connection?.subscribeUrl;
}

/** The setup-screen quick-start providers shipped in the WebUI. */
export const curatedProviders: CuratedProvider[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    vendor: 'OpenAI',
    description: 'GPT, o-series, and Codex models.',
    logoUrl: 'https://learn.chatgpt.com/favicon.png',
    logoAlt: 'OpenAI logo',
    family: 'openai',
    keyPlaceholder: 'sk-...',
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    vendor: 'Anthropic',
    description: 'Claude model access over the native Messages API.',
    logoUrl: 'https://www.anthropic.com/favicon.ico',
    logoAlt: 'Anthropic logo',
    family: 'anthropic',
    keyPlaceholder: 'sk-ant-...',
  },
  {
    id: 'google',
    name: 'Google',
    vendor: 'Google',
    description: 'Gemini Pro, Flash, and Nano.',
    logoUrl: 'https://www.google.com/favicon.ico',
    logoAlt: 'Google logo',
    family: 'google',
    keyPlaceholder: 'AIza...',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    vendor: 'DeepSeek',
    description: 'High-performance reasoning at low cost.',
    logoUrl: 'https://www.deepseek.com/favicon.ico',
    logoAlt: 'DeepSeek logo',
    family: 'openai-compatible',
    keyPlaceholder: 'sk-...',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    vendor: 'OpenRouter',
    description: 'Reach many model vendors through one aggregated key.',
    logoUrl: 'https://openrouter.ai/favicon.ico',
    logoAlt: 'OpenRouter logo',
    family: 'openai-compatible',
    keyPlaceholder: 'sk-or-...',
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    vendor: 'MiniMax',
    description:
      'One subscription for frontier coding, 1M ultra-long context and native multimodal models on a shared quota.',
    logoUrl: 'https://file.cdn.minimax.io/public/25289820-59cd-4365-9829-a3f32b365451.ico',
    logoAlt: 'MiniMax logo',
    family: 'openai-compatible',
    keyPlaceholder: 'eyJ...',
    signupUrl: signupUrlFor('minimax-token-plan'),
  },
  {
    id: 'kimi',
    name: 'Kimi',
    vendor: 'Kimi',
    description: 'Moonshot AI long-context models.',
    logoUrl: 'https://www.kimi.com/favicon.ico',
    logoAlt: 'Kimi logo',
    family: 'openai-compatible',
    keyPlaceholder: 'sk-...',
    signupUrl: signupUrlFor('kimi-for-coding'),
  },
  {
    id: 'zai',
    name: 'Z.ai (GLM)',
    vendor: 'Z.AI',
    description: 'GLM coding-plan access with broad tool compatibility.',
    logoUrl: 'https://z-cdn.chatglm.cn/z-ai/static/logo.svg',
    logoAlt: 'Z.AI logo',
    family: 'openai-compatible',
    keyPlaceholder: '...',
    signupUrl: signupUrlFor('zai-coding-plan'),
  },
  {
    id: 'opencode-go',
    name: 'OpenCode Go',
    vendor: 'OpenCode',
    description: 'Global hosted API fronting many LLM providers from US, EU and Singapore regions.',
    logoUrl: 'https://opencode.ai/favicon-96x96-v3.png',
    logoAlt: 'OpenCode logo',
    family: 'openai-compatible',
    keyPlaceholder: 'oc-...',
    signupUrl: signupUrlFor('opencode-go'),
  },
];

export interface OAuthProvider {
  id: string;
  name: string;
  description: string;
  command: string;
}

/** First-class subscription providers authenticated through a browser/device flow. */
export const oauthProviders: OAuthProvider[] = [
  {
    id: 'openai-chatgpt',
    name: 'ChatGPT plan API',
    description:
      'Continue with ChatGPT, authorize plan usage, and select models available to your account.',
    command: 'wstack auth login chatgpt-api',
  },
  {
    id: 'openai-codex',
    name: 'ChatGPT (Codex)',
    description: 'Use ChatGPT Codex subscription access after a single browser sign-in.',
    command: 'wstack auth login chatgpt',
  },
  {
    id: 'github-copilot',
    name: 'GitHub Copilot',
    description:
      'GitHub device sign-in with account-discovered chat models, visibility filtering, and automatic token renewal.',
    command: 'wstack auth login copilot',
  },
  {
    id: 'xai',
    name: 'xAI / Grok',
    description: 'Device sign-in with renewable account credentials for the Responses API.',
    command: 'wstack auth login xai',
  },
  {
    id: 'kimi-for-coding',
    name: 'Kimi Code',
    description: 'Device sign-in to Kimi Code alongside subscription API keys.',
    command: 'wstack auth login kimi',
  },
  {
    id: 'meta',
    name: 'Meta / Muse',
    description:
      'Device sign-in and renewable Model API keys; Meta controls account eligibility and billing.',
    command: 'wstack auth login meta',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    description: 'Browser sign-in that mints a user-controlled API key.',
    command: 'wstack auth login openrouter',
  },
  {
    id: 'google-antigravity',
    name: 'Google Antigravity',
    description: 'Google OAuth with a configured client and account project bootstrap.',
    command: 'wstack auth login antigravity',
  },
];

export interface LocalProvider {
  id: string;
  name: string;
  baseUrl: string;
  noAuth: boolean;
  hint: string;
}

/** Local / self-hosted OpenAI-compatible runtimes from the auth picker. */
export const localProviders: LocalProvider[] = [
  {
    id: 'omniroute',
    name: 'OmniRoute',
    baseUrl: 'http://localhost:20128/v1',
    noAuth: true,
    hint: 'WrongStack local gateway — auto-discovers models, no auth.',
  },
  {
    id: 'ollama',
    name: 'Ollama',
    baseUrl: 'http://localhost:11434/v1',
    noAuth: true,
    hint: 'Local model runner on port 11434, no auth.',
  },
  {
    id: 'vllm',
    name: 'vLLM',
    baseUrl: 'http://localhost:8000/v1',
    noAuth: false,
    hint: 'High-throughput server on port 8000, optional Bearer.',
  },
  {
    id: 'lmstudio',
    name: 'LM Studio',
    baseUrl: 'http://localhost:1234/v1',
    noAuth: false,
    hint: 'Desktop model host on port 1234, optional Bearer.',
  },
];
