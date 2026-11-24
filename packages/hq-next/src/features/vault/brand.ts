/**
 * Provider logos for the HQ Providers screen — the same reviewed Lobe Icons
 * marks WebUI ships (`public/provider-logos`, MIT, see its README), mapped the
 * same way: endpoint domain first, then the provider id or its alias. API
 * compatibility alone never picks a logo; an unknown provider gets none.
 * A copy of project-surfaces' `provider-brand.ts`, which hq-next does not
 * depend on.
 */
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
  codex: 'openai',
  'anthropic-oauth': 'anthropic',
  claude: 'anthropic',
  gemini: 'google',
  'google-antigravity': 'google',
  'opencode-go': 'opencode',
  'opencode-zen': 'opencode',
  'vercel-ai-gateway': 'vercel',
  'kimi-for-coding': 'kimi',
  moonshotai: 'moonshot',
  'zai-coding-plan': 'zai',
  zhipuai: 'zai',
  'alibaba-cn': 'alibaba',
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
  ['openrouter.ai', 'openrouter'],
  ['api.kimi.com', 'kimi'],
  ['moonshot.ai', 'moonshot'],
  ['z.ai', 'zai'],
  ['minimax.io', 'minimax'],
  ['mistral.ai', 'mistral'],
  ['deepseek.com', 'deepseek'],
  ['groq.com', 'groq'],
  ['perplexity.ai', 'perplexity'],
  ['aliyuncs.com', 'alibaba'],
  ['githubcopilot.com', 'copilot'],
  ['x.ai', 'xai'],
  ['openai.azure.com', 'azure'],
  ['cohere.com', 'cohere'],
  ['together.xyz', 'together'],
  ['fireworks.ai', 'fireworks'],
  ['cerebras.ai', 'cerebras'],
  ['huggingface.co', 'huggingface'],
];

function knownId(value: string | undefined): BrandId | undefined {
  const id = value?.trim().toLowerCase().replaceAll('_', '-');
  if (!id) return undefined;
  if (Object.hasOwn(BRANDS, id)) return id as BrandId;
  if (Object.hasOwn(ALIASES, id)) return ALIASES[id];
  // Aliases such as openai-2 or team-openai-hq keep their provider's mark.
  const canonical = id.replace(/-(?:\d+|hq)$/, '');
  return canonical !== id ? knownId(canonical) : undefined;
}

export interface ProviderBrand {
  name: string;
  src: string;
}

export function providerBrand(
  id: string,
  options: { type?: string; baseUrl?: string } = {},
): ProviderBrand | null {
  let brand: BrandId | undefined;
  if (options.baseUrl) {
    try {
      const host = new URL(options.baseUrl).hostname;
      brand = DOMAINS.find(([domain]) => host === domain || host.endsWith(`.${domain}`))?.[1];
    } catch {
      // An incomplete endpoint keeps the neutral fallback.
    }
  }
  brand ??= knownId(id) ?? knownId(options.type);
  return brand
    ? { name: BRANDS[brand].name, src: `/provider-logos/${BRANDS[brand].file}.svg` }
    : null;
}
