export class DomainError extends Error {
  constructor(
    readonly code: "unauthenticated" | "forbidden" | "not_found" | "conflict" | "invalid_input",
    readonly status: number,
  ) {
    super(code);
    this.name = "DomainError";
  }
}
