import { actions, type Action } from "./permissions";
// Presets that keep the settings UI simple. The API still takes explicit
// actions; the server limits every grant to what the caller holds.
const read: Action[] = ["project.read", "ticket.read"];
const respond: Action[] = [
  ...read,
  "ticket.reply",
  "ticket.note",
  "ticket.resolve",
  "ticket.assign",
];
export const operatorRoles = {
  none: [],
  read,
  respond,
  manage: [...actions],
} as const satisfies Record<string, readonly Action[]>;
export type OperatorRole = keyof typeof operatorRoles;
export const tokenRoles = {
  read,
  notes: [...read, "ticket.note"],
  respond: [...read, "ticket.reply", "ticket.note"],
} as const satisfies Record<string, readonly Action[]>;
export type TokenRole = keyof typeof tokenRoles;
// The preset whose actions equal the given set, or "custom".
export function roleOf<T extends string>(
  roles: Record<T, readonly Action[]>,
  granted: readonly Action[],
): T | "custom" {
  const wanted = [...new Set(granted)].sort().join(",");
  for (const [name, preset] of Object.entries(roles) as [T, readonly Action[]][])
    if ([...preset].sort().join(",") === wanted) return name;
  return "custom";
}
// A preset limited to what the caller may hand on.
export function within(preset: readonly Action[], held: readonly Action[]): Action[] {
  return preset.filter((action) => held.includes(action));
}
