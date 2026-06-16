import { createOpenAICompatibleProvider } from '@romea/model-router/openai-adapter';
import type { Provider } from '@romea/model-router';

export interface DashIntlProviderOptions {
  apiKey: string;
  baseUrl?: string;
}

export function createDashIntlProvider(
  options: DashIntlProviderOptions,
): Provider {
  return createOpenAICompatibleProvider({
    name: 'dash_intl',
    apiKey: options.apiKey,
    baseUrl:
      options.baseUrl ??
      'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  });
}
