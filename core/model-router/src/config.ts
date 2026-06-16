import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

export interface RouterConfig {
  extractModel: string;
  extractFallbackModel: string;
  generateModel: string;
  generateFallbackModel: string;

  anthropicApiKey?: string;
  anthropicBaseUrl: string;

  moonshotApiKey?: string;
  moonshotBaseUrl: string;

  googleApiKey?: string;
  googleBaseUrl: string;

  streamlakeApiKey?: string;
  streamlakeBaseUrl: string;

  dashIntlApiKey?: string;
  dashIntlBaseUrl: string;
}

const requiredModelVars = [
  'EXTRACT_MODEL',
  'EXTRACT_FALLBACK_MODEL',
  'GENERATE_MODEL',
  'GENERATE_FALLBACK_MODEL',
] as const;

function loadDotenv(paths: string[]) {
  for (const p of paths) {
    if (!existsSync(p)) continue;
    const text = readFileSync(p, 'utf-8');
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx === -1) continue;
      const key = trimmed.slice(0, idx).trim();
      const value = trimmed.slice(idx + 1).trim();
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  }
}

export function loadConfig(options?: { dotenvPaths?: string[] }): RouterConfig {
  const dotenvPaths = options?.dotenvPaths ?? [
    resolve(process.cwd(), 'clients/scm/.env'),
    resolve('/root/.openclaw/bridge/.env'),
  ];
  loadDotenv(dotenvPaths);

  const missing: string[] = [];
  for (const key of requiredModelVars) {
    if (!process.env[key]) missing.push(key);
  }
  if (missing.length) {
    throw new Error(
      `Missing required model-router environment variables: ${missing.join(', ')}`,
    );
  }

  const config: RouterConfig = {
    extractModel: process.env.EXTRACT_MODEL!,
    extractFallbackModel: process.env.EXTRACT_FALLBACK_MODEL!,
    generateModel: process.env.GENERATE_MODEL!,
    generateFallbackModel: process.env.GENERATE_FALLBACK_MODEL!,

    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    anthropicBaseUrl:
      process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com/v1',

    moonshotApiKey: process.env.MOONSHOT_API_KEY,
    moonshotBaseUrl:
      process.env.MOONSHOT_BASE_URL ?? 'https://api.moonshot.ai/v1',

    googleApiKey: process.env.GEMINI_API_KEY,
    googleBaseUrl:
      process.env.GOOGLE_BASE_URL ??
      'https://generativelanguage.googleapis.com/v1beta/openai',

    streamlakeApiKey: process.env.STREAMLAKE_API_KEY,
    streamlakeBaseUrl:
      process.env.STREAMLAKE_BASE_URL ??
      'https://vanchin.streamlake.ai/api/gateway/v1/endpoints',

    dashIntlApiKey:
      process.env.DASHSCOPE_SG_KEY ?? process.env.STREAMLAKE_API_KEY,
    dashIntlBaseUrl:
      process.env.DASHSCOPE_INTL_BASE_URL ??
      'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  };

  for (const [key, value] of Object.entries(config)) {
    if (key.endsWith('Model') && (!value || typeof value !== 'string')) {
      throw new Error(`Router config value "${key}" is missing or malformed`);
    }
  }

  return config;
}
