export type AuthMode = 'oauth' | 'apikey';

export interface ProviderModel {
  id: string;
  label: string;
}
export interface ProviderInfo {
  id: string;
  label: string;
  authMode: AuthMode;
  models: ProviderModel[];
  description: string;
}

export const PROVIDERS: ProviderInfo[] = [
  {
    id: 'openai-codex',
    label: 'Codex (ChatGPT Plus/Pro)',
    authMode: 'oauth',
    description: 'Login con account ChatGPT, usa l\'abbonamento Plus o Pro.',
    models: [
      { id: 'gpt-5.5', label: 'GPT-5.5' },
      { id: 'gpt-5.4', label: 'GPT-5.4' },
    ],
  },
  {
    id: 'anthropic',
    label: 'Claude (Pro/Max)',
    authMode: 'oauth',
    description: 'Login con account Claude, usa l\'abbonamento Pro o Max.',
    models: [
      { id: 'claude-opus-4-7', label: 'Claude Opus 4.7' },
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
    ],
  },
  {
    id: 'github-copilot',
    label: 'GitHub Copilot',
    authMode: 'oauth',
    description: 'Login con GitHub, usa l\'abbonamento Copilot.',
    models: [
      { id: 'claude-3-5-sonnet', label: 'Claude 3.5 Sonnet' },
      { id: 'gpt-5.4', label: 'GPT-5.4' },
      { id: 'gpt-4o', label: 'GPT-4o' },
    ],
  },
  {
    id: 'opencode',
    label: 'OpenCode (Zen)',
    authMode: 'apikey',
    description: 'API key da opencode.ai/zen.',
    models: [
      { id: 'kimi-k2.6', label: 'Kimi K2.6' },
      { id: 'glm-5.1', label: 'GLM 5.1' },
      { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
    ],
  },
  {
    id: 'opencode-go',
    label: 'OpenCode Go',
    authMode: 'apikey',
    description: 'API key da opencode.ai (piano Go).',
    models: [
      { id: 'kimi-k2.6', label: 'Kimi K2.6' },
      { id: 'glm-5.1', label: 'GLM 5.1' },
      { id: 'minimax-m2.7', label: 'MiniMax M2.7' },
      { id: 'qwen3.6-plus', label: 'Qwen 3.6 Plus' },
    ],
  },
  {
    id: 'openai',
    label: 'OpenAI API',
    authMode: 'apikey',
    description: 'API key pay-per-token da platform.openai.com.',
    models: [
      { id: 'gpt-5.4', label: 'GPT-5.4' },
      { id: 'gpt-5.5', label: 'GPT-5.5' },
    ],
  },
];

export function findProvider(id: string): ProviderInfo | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

export function parseSelected(selected: string): { provider: string; model: string } {
  const [provider, ...rest] = selected.split('/');
  return { provider, model: rest.join('/') };
}
