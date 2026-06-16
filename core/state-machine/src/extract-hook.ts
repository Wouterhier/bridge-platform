import type { Engine } from "./engine.js";
import type { Conversation } from "./types.js";

export interface RunTurnDeps<S extends string, F extends string, C> {
  db: {
    processed_messages: string[];
  };
}

export interface TurnMessage<S extends string, C> {
  id: string;
  rawMessage: string;
  conversation: Conversation<S>;
  context?: C;
}

export interface TurnResult<S extends string> {
  state: S;
  collected: Record<string, unknown>;
  rePrompt: boolean;
  alreadyProcessed?: boolean;
  validationError?: string;
  missingField?: string;
  reply?: string;
  extraction?: unknown;
}

export async function runTurn<S extends string, F extends string, C>(
  engine: Engine<S, F, C>,
  extractFn: (
    rawMessage: string,
    field: F,
    promptContext: string,
  ) => Promise<unknown>,
  generateFn: (
    state: S,
    promptContext: string,
    errorKey?: string,
  ) => Promise<string>,
  deps: RunTurnDeps<S, F, C>,
  message: TurnMessage<S, C>,
): Promise<TurnResult<S>> {
  if (deps.db.processed_messages.includes(message.id)) {
    return {
      state: message.conversation.currentState,
      collected: message.conversation.collected,
      rePrompt: false,
      alreadyProcessed: true,
    };
  }

  const transition = await engine.process({
    rawMessage: message.rawMessage,
    conversation: message.conversation,
    context: message.context,
  });

  const stateDef = engine.config.states[transition.state];
  const promptContext = stateDef.buildPromptContext(
    transition.collected as Record<F, unknown>,
    message.context as C,
  );

  if (transition.rePrompt) {
    const reply = await generateFn(
      transition.state,
      promptContext,
      transition.validationError,
    );
    return {
      ...transition,
      reply,
    };
  }

  if (transition.missingField) {
    const extraction = await extractFn(
      message.rawMessage,
      transition.missingField as F,
      promptContext,
    );
    return {
      ...transition,
      extraction,
    };
  }

  return transition;
}
