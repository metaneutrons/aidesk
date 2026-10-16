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
      // A model answered, but not with a translation that can be shown.
      | "translation_unusable"
      // A source outside the product that was asked did not answer as needed.
      | "source_unavailable"
      // A task that asks a model ended without an answer.
      | AiFailure,
    readonly status: number,
    // How long the caller is asked to wait, in seconds, when a provider said.
    readonly retryAfterSeconds?: number,
  ) {
    super(code);
    this.name = "DomainError";
  }
}
