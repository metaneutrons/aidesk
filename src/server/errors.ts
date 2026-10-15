import type { AiFailure } from "../domain/ai";
export class DomainError extends Error {
  constructor(
    readonly code:
      | "unauthenticated"
      | "forbidden"
      | "not_found"
      | "conflict"
      | "stale_version"
      | "idempotency_conflict"
      | "invalid_input"
      | "rate_limited"
      // A task that asks a model ended without an answer.
      | AiFailure,
    readonly status: number,
  ) {
    super(code);
    this.name = "DomainError";
  }
}
