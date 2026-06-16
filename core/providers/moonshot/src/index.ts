import { createOpenAICompatibleProvider } from '@romea/model-router/openai-adapter';
import type { ModelRequest, Provider } from '@romea/model-router';

export interface MoonshotProviderOptions {
  apiKey: string;
  baseUrl?: string;
}

export function createMoonshotProvider(
  options: MoonshotProviderOptions,
): Provider {
  return createOpenAICompatibleProvider({
    name: 'moonshot',
    apiKey: options.apiKey,
    baseUrl: options.baseUrl ?? 'https://api.moonshot.ai/v1',
    onBeforeRequest(body, req: ModelRequest) {
      // kimi-k2.6 only accepts temperature=1.
      if (req.model?.includes('kimi-k2.6')) {
        body.temperature = 1;
      }
    },
  });
}
