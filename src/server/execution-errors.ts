/** Only these application-authored messages may be returned to a client. */
export class ExecutionError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); this.name = 'ExecutionError'; }
}
export function safeExecutionError(error: unknown): ExecutionError {
  return error instanceof ExecutionError ? error : new ExecutionError(502, 'provider_unavailable', 'The provider request failed. No upstream response or credential details are exposed.');
}
