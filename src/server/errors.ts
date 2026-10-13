export class DomainError extends Error {
  constructor(
    readonly code:
      "unauthenticated" | "forbidden" | "not_found" | "conflict" | "invalid_input" | "rate_limited",
    readonly status: number,
  ) {
    super(code);
    this.name = "DomainError";
  }
}
