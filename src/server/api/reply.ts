// A route result with a status of its own, for operations whose outcome decides
// between, for example, 200 (applied) and 202 (proposed).
export class Reply {
  constructor(
    readonly value: unknown,
    readonly status: number,
  ) {}
}
