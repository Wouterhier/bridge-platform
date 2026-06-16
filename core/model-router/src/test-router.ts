import { config } from 'dotenv';
import { resolve } from 'node:path';
import { ModelRouter } from './router.js';
import { loadConfig } from './config.js';
import { AnthropicProvider } from '@romea/provider-anthropic';
import { createMoonshotProvider } from '@romea/provider-moonshot';
import { createGoogleProvider } from '@romea/provider-google';
import { createStreamlakeProvider } from '@romea/provider-streamlake';
import type { ModelRequest } from './types.js';

// Load env from client env first, then bridge fallback, without overwriting existing vars.
config({ path: resolve(process.cwd(), 'clients/scm/.env'), override: false });
config({ path: resolve('/root/.openclaw/bridge/.env'), override: false });

const baseConfig = loadConfig({ dotenvPaths: [] });

function createRouter(cfg = baseConfig) {
  return new ModelRouter({
    config: cfg,
    providers: {
      anth_api: new AnthropicProvider({
        apiKey: cfg.anthropicApiKey ?? '',
        baseUrl: cfg.anthropicBaseUrl,
      }),
      moon_api: createMoonshotProvider({
        apiKey: cfg.moonshotApiKey ?? '',
        baseUrl: cfg.moonshotBaseUrl,
      }),
      google: createGoogleProvider({
        apiKey: cfg.googleApiKey ?? '',
        baseUrl: cfg.googleBaseUrl,
      }),
      zai: createStreamlakeProvider({
        apiKey: cfg.streamlakeApiKey ?? '',
        baseUrl: cfg.streamlakeBaseUrl,
      }),
    },
  });
}

const extractRequest: ModelRequest = {
  role: 'extract',
  system:
    'You are a structured-data extractor. Extract the requested fields and return only a JSON object.',
  messages: [
    {
      role: 'user',
      content:
        'Extract the name and age from: "Alice is 30 years old." Return JSON like {"name": "...", "age": ...}.',
    },
  ],
  temperature: 0.1,
  responseFormat: { type: 'json_object' },
};

const generateRequest: ModelRequest = {
  role: 'generate',
  system: 'You are a helpful assistant. Keep answers under 20 words.',
  messages: [{ role: 'user', content: 'Say hello to the test suite.' }],
  temperature: 0.5,
};

async function run() {
  const router = createRouter();

  console.log('\n--- Extract request ---');
  try {
    const extractRes = await router.complete('extract', extractRequest);
    console.log('Extract success:', {
      model: extractRes.model,
      provider: extractRes.provider,
      usage: extractRes.usage,
      text: extractRes.text.slice(0, 200),
    });
  } catch (err) {
    console.error('Extract failed:', err);
  }

  console.log('\n--- Generate request ---');
  try {
    const generateRes = await router.complete('generate', generateRequest);
    console.log('Generate success:', {
      model: generateRes.model,
      provider: generateRes.provider,
      usage: generateRes.usage,
      text: generateRes.text.slice(0, 200),
    });
  } catch (err) {
    console.error('Generate failed:', err);
  }

  console.log('\n--- Fallback path test ---');
  const brokenConfig = {
    ...baseConfig,
    extractModel: 'google/broken-model',
    googleBaseUrl: 'http://localhost:1', // force a retryable connection failure on primary only
  };
  const fallbackRouter = createRouter(brokenConfig);
  try {
    const fallbackRes = await fallbackRouter.complete('extract', extractRequest);
    console.log('Fallback success:', {
      model: fallbackRes.model,
      provider: fallbackRes.provider,
      text: fallbackRes.text.slice(0, 200),
    });
  } catch (err) {
    console.error('Fallback failed:', (err as Error).message);
  }
}

run().then(() => process.exit(0));
