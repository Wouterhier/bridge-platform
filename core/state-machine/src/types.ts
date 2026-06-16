export interface ValidationResult<T> {
  ok: boolean;
  value?: T;
  error?: string; // machine-readable error key
}

export interface StateDefinition<S extends string, F extends string, C> {
  id: S;
  requiredField?: F;
  validate: (
    raw: string,
    collected: Record<F, unknown>,
    context: C,
  ) => ValidationResult<unknown> | Promise<ValidationResult<unknown>>;
  next: (collected: Record<F, unknown>, context: C) => S | Promise<S>;
  buildPromptContext: (collected: Record<F, unknown>, context: C) => string;
}

export interface StateMachineConfig<S extends string, F extends string, C> {
  states: Record<S, StateDefinition<S, F, C>>;
  initialState: S;
}

export interface TransitionResult<S extends string> {
  state: S;
  collected: Record<string, unknown>;
  rePrompt: boolean;
  missingField?: string;
  validationError?: string;
}

export interface Conversation<S extends string> {
  currentState: S;
  collected: Record<string, unknown>;
}
