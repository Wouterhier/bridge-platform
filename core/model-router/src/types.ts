export type MessageRole = 'system' | 'user' | 'assistant';

export interface Message {
  role: MessageRole;
  content: string;
}

export interface ModelRequest {
  role: 'extract' | 'generate';
  model?: string; // provider/model-id, set by router before calling adapter
  system: string; // cached static prefix
  messages: Message[]; // full history
  temperature: number;
  maxTokens?: number;
  responseFormat?: { type: 'json_object' | 'text' };
}

export interface ModelResponse {
  text: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  model: string;
  provider: string;
}

export interface Provider {
  name: string;
  complete(req: ModelRequest): Promise<ModelResponse>;
}

export class ModelRouterError extends Error {
  constructor(
    message: string,
    public readonly primaryError: unknown,
    public readonly fallbackError?: unknown,
  ) {
    super(message);
    this.name = 'ModelRouterError';
  }
}
