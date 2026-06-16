import type {
  Conversation,
  StateMachineConfig,
  TransitionResult,
} from "./types.js";

export type Engine<S extends string, F extends string, C> = ReturnType<
  typeof createEngine<S, F, C>
>;

export function createEngine<S extends string, F extends string, C>(
  config: StateMachineConfig<S, F, C>,
) {
  function getCurrentState(conversation: Conversation<S>): S {
    const state = conversation.currentState;
    if (!config.states[state]) {
      throw new Error(`Unknown state: ${state}`);
    }
    return state;
  }

  async function process(input: {
    rawMessage: string;
    conversation: Conversation<S>;
    context?: C;
  }): Promise<TransitionResult<S>> {
    const stateId = getCurrentState(input.conversation);
    const definition = config.states[stateId];
    const collected = { ...input.conversation.collected } as Record<
      string,
      unknown
    >;
    const context = input.context as C;

    if (definition.requiredField) {
      const result = await definition.validate(
        input.rawMessage,
        collected as Record<F, unknown>,
        context,
      );
      if (!result.ok) {
        return {
          state: stateId,
          collected,
          rePrompt: true,
          validationError: result.error,
        };
      }
      collected[definition.requiredField] = result.value;
    }

    const nextState = await definition.next(
      collected as Record<F, unknown>,
      context,
    );

    const nextDefinition = config.states[nextState];
    if (!nextDefinition) {
      throw new Error(`Unknown next state: ${nextState}`);
    }

    return {
      state: nextState,
      collected,
      rePrompt: false,
      missingField: nextDefinition.requiredField,
    };
  }

  return {
    getCurrentState,
    process,
    config,
  };
}
