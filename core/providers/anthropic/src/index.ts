import type {
  Message,
  ModelRequest,
  ModelResponse,
  Provider,
} from '@romea/model-router';

interface AnthropicTextBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: AnthropicTextBlock[];
}

interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface AnthropicResponse {
  id: string;
  type: string;
  role: 'assistant';
  content: AnthropicTextBlock[];
  model: string;
  usage: AnthropicUsage;
}

export interface AnthropicProviderOptions {
  apiKey: string;
  baseUrl?: string;
}

export class AnthropicProvider implements Provider {
  name = 'anthropic';
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(options: AnthropicProviderOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? 'https://api.anthropic.com/v1').replace(
      /\/$/,
      '',
    );
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    const modelId = extractModelId(req);
    const systemBlock: AnthropicTextBlock = {
      type: 'text',
      text: req.system,
      cache_control: { type: 'ephemeral' },
    };

    const messages = this.toAnthropicMessages(req.messages);

    const body: Record<string, unknown> = {
      model: modelId,
      max_tokens: req.maxTokens ?? 4096,
      temperature: req.temperature,
      system: [systemBlock],
      messages,
    };

    if (req.responseFormat?.type === 'json_object') {
      body.system = [
        {
          type: 'text',
          text: `${req.system}\n\nRespond with valid JSON only. Do not include markdown code fences.`,
          cache_control: { type: 'ephemeral' },
        },
      ];
    }

    const res = await fetch(`${this.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => 'unknown');
      throw new Error(
        `Anthropic API error ${res.status}: ${text.slice(0, 500)}`,
      );
    }

    const data = (await res.json()) as AnthropicResponse;
    const text = data.content
      .filter((b): b is AnthropicTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');

    return {
      text,
      model: data.model,
      provider: this.name,
      usage: {
        promptTokens: data.usage.input_tokens,
        completionTokens: data.usage.output_tokens,
        cacheReadTokens: data.usage.cache_read_input_tokens,
        cacheWriteTokens: data.usage.cache_creation_input_tokens,
      },
    };
  }

  private toAnthropicMessages(messages: Message[]): AnthropicMessage[] {
    const result: AnthropicMessage[] = [];
    let lastUserIndex = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        lastUserIndex = i;
        break;
      }
    }
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (m.role === 'system') continue; // system handled separately
      const block: AnthropicTextBlock = { type: 'text', text: m.content };
      if (m.role === 'user' && i === lastUserIndex) {
        block.cache_control = { type: 'ephemeral' };
      }
      result.push({ role: m.role, content: [block] });
    }
    return result;
  }
}

function extractModelId(req: ModelRequest): string {
  // The router passes the full model string; strip provider prefix if present.
  const model = req.model ?? 'claude-sonnet-4-6';
  const slash = model.indexOf('/');
  if (slash > -1) {
    return model.slice(slash + 1);
  }
  return model;
}
