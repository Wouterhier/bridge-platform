import { createOpenAICompatibleProvider } from '@romea/model-router/openai-adapter';
import type { Provider } from '@romea/model-router';

export interface GoogleProviderOptions {
  apiKey: string;
  baseUrl?: string;
}

export function createGoogleProvider(options: GoogleProviderOptions): Provider {
  return createOpenAICompatibleProvider({
    name: 'google',
    apiKey: options.apiKey,
    baseUrl:
      options.baseUrl ??
      'https://generativelanguage.googleapis.com/v1beta/openai',
  });
}
