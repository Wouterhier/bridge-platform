import type { Message, ModelRequest, ModelResponse } from './types.js';

interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
}

interface OpenAIChoice {
  message: { role: string; content: string | null; refusal?: string };
  finish_reason: string;
}

interface OpenAIResponse {
  id: string;
  object: string;
  model: string;
  choices: OpenAIChoice[];
  usage?: OpenAIUsage;
}

export interface OpenAICompatibleOptions {
  name: string;
  apiKey: string;
  baseUrl: string;
  onBeforeRequest?: (body: Record<string, unknown>, req: ModelRequest) => void;
}

export function createOpenAICompatibleProvider(options: OpenAICompatibleOptions) {
  const baseUrl = options.baseUrl.replace(/\/$/, '');

  async function complete(req: ModelRequest): Promise<ModelResponse> {
    const modelId = extractModelId(req);
    const messages: Message[] = [
      { role: 'system', content: req.system },
      ...req.messages,
    ];

    const body: Record<string, unknown> = {
      model: modelId,
      messages,
      temperature: req.temperature,
    };

    if (req.maxTokens !== undefined) {
      body.max_tokens = req.maxTokens;
    }

    if (req.responseFormat?.type === 'json_object') {
      body.response_format = { type: 'json_object' };
    }

    options.onBeforeRequest?.(body, req);

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => 'unknown');
      throw new Error(
        `${options.name} API error ${res.status}: ${text.slice(0, 500)}`,
      );
    }

    const data = (await res.json()) as OpenAIResponse;
    const choice = data.choices[0];
    if (!choice) throw new Error(`${options.name} returned no choices`);

    const text = choice.message.content ?? choice.message.refusal ?? '';

    return {
      text,
      model: data.model,
      provider: options.name,
      usage: data.usage
        ? {
            promptTokens: data.usage.prompt_tokens,
            completionTokens: data.usage.completion_tokens,
          }
        : undefined,
    };
  }

  return {
    name: options.name,
    complete,
  };
}

function extractModelId(req: ModelRequest): string {
  const model = req.model ?? '';
  const slash = model.indexOf('/');
  if (slash > -1) {
    return model.slice(slash + 1);
  }
  return model;
}
