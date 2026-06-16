import { createOpenAICompatibleProvider } from '@romea/model-router/openai-adapter';
import type { Provider } from '@romea/model-router';

export interface StreamlakeProviderOptions {
  apiKey: string;
  baseUrl?: string;
}

export function createStreamlakeProvider(
  options: StreamlakeProviderOptions,
): Provider {
  return createOpenAICompatibleProvider({
    name: 'streamlake',
    apiKey: options.apiKey,
    baseUrl:
      options.baseUrl ??
      'https://vanchin.streamlake.ai/api/gateway/v1/endpoints',
  });
}
