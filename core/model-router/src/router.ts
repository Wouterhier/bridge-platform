import type { ModelRequest, ModelResponse, Provider } from './types.js';
import { ModelRouterError } from './types.js';
import { loadConfig, type RouterConfig } from './config.js';

export type ModelRole = 'extract' | 'generate';

export interface RouterOptions {
  config?: RouterConfig;
  providers?: Record<string, Provider>;
}

interface ParsedModel {
  providerName: string;
  modelId: string;
}

export class ModelRouter {
  private readonly config: RouterConfig;
  private readonly providers = new Map<string, Provider>();

  constructor(options: RouterOptions = {}) {
    this.config = options.config ?? loadConfig();
    const entries = Object.entries(options.providers ?? {});
    if (entries.length === 0) {
      throw new Error(
        'At least one provider must be registered with the router',
      );
    }
    for (const [name, provider] of entries) {
      this.providers.set(name, provider);
    }
  }

  async complete(role: ModelRole, req: ModelRequest): Promise<ModelResponse> {
    const primaryModel =
      role === 'extract' ? this.config.extractModel : this.config.generateModel;
    const fallbackModel =
      role === 'extract'
        ? this.config.extractFallbackModel
        : this.config.generateFallbackModel;

    const start = Date.now();
    let primaryErr: unknown;

    try {
      const res = await this.callModel(role, primaryModel, req);
      this.log(role, primaryModel, start, res);
      return res;
    } catch (err) {
      primaryErr = err;
      if (!isRetryable(err)) throw err;
    }

    try {
      const res = await this.callModel(role, fallbackModel, req);
      this.log(role, `${primaryModel} -> ${fallbackModel}`, start, res);
      return res;
    } catch (fallbackErr) {
      throw new ModelRouterError(
        `Model call failed for role "${role}". Primary: ${primaryModel}, Fallback: ${fallbackModel}`,
        primaryErr,
        fallbackErr,
      );
    }
  }

  async escalate(role: ModelRole, req: ModelRequest): Promise<ModelResponse> {
    const escalationModel =
      role === 'extract'
        ? 'anth_api/claude-sonnet-4-6'
        : 'anth_api/claude-opus-4-6';
    const start = Date.now();
    const res = await this.callModel(role, escalationModel, req);
    this.log(role, `${escalationModel} (escalation)`, start, res);
    return res;
  }

  private async callModel(
    role: ModelRole,
    modelString: string,
    req: ModelRequest,
  ): Promise<ModelResponse> {
    const parsed = this.parseModel(modelString);
    const provider = this.providers.get(parsed.providerName);
    if (!provider) {
      throw new Error(
        `Unknown provider "${parsed.providerName}" in model "${modelString}"`,
      );
    }

    const requestWithModel: ModelRequest = {
      ...req,
      role,
      model: modelString,
    };

    return provider.complete(requestWithModel);
  }

  private parseModel(modelString: string): ParsedModel {
    const idx = modelString.indexOf('/');
    if (idx === -1) {
      throw new Error(
        `Model string "${modelString}" must be in format <provider>/<model-id>`,
      );
    }
    return {
      providerName: modelString.slice(0, idx),
      modelId: modelString.slice(idx + 1),
    };
  }

  private log(
    role: ModelRole,
    model: string,
    startMs: number,
    res: ModelResponse,
  ) {
    const duration = Date.now() - startMs;
    const cacheInfo: string[] = [];
    if (res.usage?.cacheReadTokens !== undefined) {
      cacheInfo.push(`cacheRead=${res.usage.cacheReadTokens}`);
    }
    if (res.usage?.cacheWriteTokens !== undefined) {
      cacheInfo.push(`cacheWrite=${res.usage.cacheWriteTokens}`);
    }
    const usage = res.usage
      ? `tokens=${res.usage.promptTokens}/${res.usage.completionTokens}`
      : 'tokens=unknown';
    console.log(
      `[model-router] role=${role} model=${model} provider=${res.provider} duration=${duration}ms ${usage}${cacheInfo.length ? ' ' + cacheInfo.join(' ') : ''}`,
    );
  }
}

function isRetryable(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (msg.includes('timeout')) return true;
    if (msg.includes('fetch failed')) return true;
    if (msg.includes('econnrefused')) return true;
    if (msg.includes('etimedout')) return true;
    const statusMatch = msg.match(/\b(5\d{2}|429)\b/);
    if (statusMatch) return true;
  }
  return false;
}
