/** Local, reviewed brand assets. API compatibility alone never determines a logo. */
const BRANDS = {
  openai: { name: 'OpenAI', file: 'openai' },
  anthropic: { name: 'Anthropic', file: 'anthropic' },
  google: { name: 'Google', file: 'google-color' },
  opencode: { name: 'OpenCode', file: 'opencode' },
  vercel: { name: 'Vercel', file: 'vercel' },
  openrouter: { name: 'OpenRouter', file: 'openrouter-color' },
  kimi: { name: 'Kimi', file: 'kimi-color' },
  moonshot: { name: 'Moonshot AI', file: 'moonshot' },
  zai: { name: 'Z.AI', file: 'zai' },
  minimax: { name: 'MiniMax', file: 'minimax-color' },
  mistral: { name: 'Mistral AI', file: 'mistral-color' },
  deepseek: { name: 'DeepSeek', file: 'deepseek-color' },
  groq: { name: 'Groq', file: 'groq' },
  perplexity: { name: 'Perplexity', file: 'perplexity-color' },
  alibaba: { name: 'Alibaba Cloud', file: 'alibabacloud-color' },
  copilot: { name: 'GitHub Copilot', file: 'githubcopilot' },
  ollama: { name: 'Ollama', file: 'ollama' },
  lmstudio: { name: 'LM Studio', file: 'lmstudio' },
  xai: { name: 'xAI', file: 'xai' },
  meta: { name: 'Meta', file: 'meta-color' },
  bedrock: { name: 'Amazon Bedrock', file: 'bedrock-color' },
  azure: { name: 'Azure', file: 'azure-color' },
  cohere: { name: 'Cohere', file: 'cohere-color' },
  together: { name: 'Together AI', file: 'together-color' },
  fireworks: { name: 'Fireworks AI', file: 'fireworks-color' },
  cerebras: { name: 'Cerebras', file: 'cerebras-color' },
  huggingface: { name: 'Hugging Face', file: 'huggingface-color' },
  qwen: { name: 'Qwen', file: 'qwen-color' },
} as const;

type BrandId = keyof typeof BRANDS;
const ALIASES: Readonly<Record<string, BrandId>> = {
  'openai-codex': 'openai',
  'openai-chatgpt': 'openai',
  chatgpt: 'openai',
  'chatgpt-api': 'openai',
  codex: 'openai',
  'anthropic-oauth': 'anthropic',
  claude: 'anthropic',
  gemini: 'google',
  'google-antigravity': 'google',
  'gemini-cli': 'google',
  'opencode-go': 'opencode',
  'opencode-zen': 'opencode',
  'ai-gateway': 'vercel',
  'vercel-ai-gateway': 'vercel',
  'kimi-for-coding': 'kimi',
  'kimi-code': 'kimi',
  moonshotai: 'moonshot',
  'zai-coding-plan': 'zai',
  'z-ai': 'zai',
  zhipuai: 'zai',
  'alibaba-token-plan': 'alibaba',
  'alibaba-cn': 'alibaba',
  'alibaba-coding-plan': 'alibaba',
  'alibaba-cn-coding-plan': 'alibaba',
  alibabacloud: 'alibaba',
  dashscope: 'alibaba',
  'github-copilot': 'copilot',
  'lm-studio': 'lmstudio',
  'azure-openai': 'azure',
  'amazon-bedrock': 'bedrock',
  'together-ai': 'together',
  'fireworks-ai': 'fireworks',
};

const DOMAINS: ReadonlyArray<readonly [string, BrandId]> = [
  ['openai.com', 'openai'],
  ['anthropic.com', 'anthropic'],
  ['googleapis.com', 'google'],
  ['opencode.ai', 'opencode'],
  ['ai-gateway.vercel.sh', 'vercel'],
  ['openrouter.ai', 'openrouter'],
  ['api.kimi.com', 'kimi'],
  ['api.moonshot.ai', 'moonshot'],
  ['api.moonshot.cn', 'moonshot'],
  ['z.ai', 'zai'],
  ['bigmodel.cn', 'zai'],
  ['minimax.io', 'minimax'],
  ['minimaxi.com', 'minimax'],
  ['mistral.ai', 'mistral'],
  ['deepseek.com', 'deepseek'],
  ['groq.com', 'groq'],
  ['perplexity.ai', 'perplexity'],
  ['aliyuncs.com', 'alibaba'],
  ['githubcopilot.com', 'copilot'],
  ['x.ai', 'xai'],
  ['api.meta.ai', 'meta'],
  ['openai.azure.com', 'azure'],
  ['services.ai.azure.com', 'azure'],
  ['cohere.com', 'cohere'],
  ['cohere.ai', 'cohere'],
  ['together.xyz', 'together'],
  ['together.ai', 'together'],
  ['fireworks.ai', 'fireworks'],
  ['cerebras.ai', 'cerebras'],
  ['huggingface.co', 'huggingface'],
];

function knownId(value: string | undefined): BrandId | undefined {
  const id = value?.trim().toLowerCase().replaceAll('_', '-');
  if (!id) return undefined;
  if (Object.hasOwn(BRANDS, id)) return id as BrandId;
  if (Object.hasOwn(ALIASES, id)) return ALIASES[id];
  // Settings generates duplicate profile ids such as openai-2 and zai-coding-plan-3.
  const canonical = id.replace(/-\d+$/, '');
  if (canonical !== id) return knownId(canonical);
  return undefined;
}

const SIGN_IN_TYPES = new Set([
  'openai-codex',
  'openai-chatgpt',
  'anthropic-oauth',
  'google-antigravity',
  'github-copilot',
  'chatgpt',
  'chatgpt-api',
  'codex',
  'claude',
  'copilot',
  'gemini-cli',
]);

export function resolveProviderBrand(providerId: string, baseUrl?: string, providerType?: string) {
  let id: BrandId | undefined;
  if (baseUrl) {
    try {
      const url = new URL(baseUrl);
      if (url.protocol === 'https:' || url.protocol === 'http:') {
        id = DOMAINS.find(
          ([domain]) => url.hostname === domain || url.hostname.endsWith(`.${domain}`),
        )?.[1];
      }
    } catch {
      /* An incomplete custom endpoint keeps its neutral fallback. */
    }
  }
  id ??=
    knownId(providerId) ??
    (providerType && SIGN_IN_TYPES.has(providerType) ? knownId(providerType) : undefined);
  return id ? { id, name: BRANDS[id].name, src: `/provider-logos/${BRANDS[id].file}.svg` } : null;
}
