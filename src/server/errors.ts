import type { AiFailure } from "../domain/ai";
import type { AttachmentRefusal } from "../domain/attachments";
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
      // The project is archived: it keeps its data and takes no change.
      | "project_archived"
      // The project is too large for an export that is made in one piece; its data is taken with the backup.
      | "project_export_too_large"
      // A project is deleted only after an export that was made once it was archived.
      | "export_required"
      // A file that was sent is not accepted.
      | AttachmentRefusal
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
